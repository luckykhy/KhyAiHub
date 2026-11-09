#requires -Version 5.1
<#
  scripts/start.ps1 — 启动本机 daemon（单例）并等待就绪

  流程：
    1. 检查 node；确保状态目录与 operator.token 存在（缺失则按 install 的同一规则生成）；
    2. 若 runtime.json + /health 已经就绪，直接报告“已在运行”，不重复启动；
    3. 调用 `node bin/cli.js start --state-dir <实际目录>`；
    4. 轮询 runtime.json 与 http://127.0.0.1:<port>/health，超时打印 daemon.log 尾部。

  本脚本不 spawn adb、不写 mcp.json、不打印 token。
  退出码 3 表示 daemon_unavailable（进程未写出 runtime.json 或 /health 未就绪），脚本如实转述。
#>
[CmdletBinding()]
param(
  [int]$TimeoutSec = 15,
  [string]$StateDir = '',
  [switch]$NoWait,
  [switch]$Json
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Node/adb emit UTF-8; avoid OEM-code-page mojibake when capturing their output.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

$script:Root = Split-Path -Parent $PSScriptRoot
$script:Report = [ordered]@{
  ok = $false
  command = 'start'
  steps = @()
}

function Add-Step {
  param([string]$Name, [string]$Level, [string]$Detail)
  $script:Report.steps += [ordered]@{ name = $Name; level = $Level; detail = $Detail }
  if (-not $Json) {
    $color = switch ($Level) {
      'ok' { 'Green' }
      'warn' { 'Yellow' }
      'fail' { 'Red' }
      default { 'Gray' }
    }
    Write-Host ("[{0}] {1}: {2}" -f $Level, $Name, $Detail) -ForegroundColor $color
  }
}

function Finish {
  param([int]$Code)
  $script:Report.ok = ($Code -eq 0)
  if ($Json) { $script:Report | ConvertTo-Json -Depth 8 }
  exit $Code
}

<# Native capture without PowerShell 5.1 turning native stderr into a throw. #>
function Invoke-Native {
  param([string]$Exe, [string[]]$Arguments)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = (& $Exe @Arguments 2>&1 | Out-String)
    $code = $LASTEXITCODE
    return [pscustomobject]@{ code = $code; output = $output }
  } finally {
    $ErrorActionPreference = $previous
  }
}

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Add-Step 'node' 'fail' '未找到 node（需要 >= 22）。'
  Finish 1
}
$nodeExe = $nodeCmd.Source
if (-not $nodeExe -and $nodeCmd.PSObject.Properties.Name -contains 'Path') { $nodeExe = $nodeCmd.Path }
$nodeVersionResult = Invoke-Native -Exe $nodeExe -Arguments @('-v')
$nodeVersion = $nodeVersionResult.output.Trim()
if ($nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) {
  Add-Step 'node' 'fail' ("Node 版本不满足要求：{0}" -f $nodeVersion)
  Finish 1
}
Add-Step 'node' 'ok' ("{0}（{1}）" -f $nodeExe, $nodeVersion)

$cli = Join-Path $script:Root 'bin\cli.js'
if (-not (Test-Path -LiteralPath $cli)) {
  Add-Step 'cli' 'fail' ("缺少 CLI 入口：{0}" -f $cli)
  Finish 1
}

# ── 状态目录与 token ────────────────────────────────────────────────────────
function Resolve-StateDirPath {
  param([string]$Override)
  if ($Override) { return [System.IO.Path]::GetFullPath($Override) }
  if ($env:KHY_AMOON_HOME -and $env:KHY_AMOON_HOME.Trim()) {
    return [System.IO.Path]::GetFullPath($env:KHY_AMOON_HOME.Trim())
  }
  if ($env:LOCALAPPDATA -and $env:LOCALAPPDATA.Trim()) { return (Join-Path $env:LOCALAPPDATA 'khy-amoon-bridge') }
  return (Join-Path $HOME 'AppData\Local\khy-amoon-bridge')
}

$resolvedStateDir = Resolve-StateDirPath -Override $StateDir
$operatorTokenPath = Join-Path $resolvedStateDir 'operator.token'

if (-not (Test-Path -LiteralPath $resolvedStateDir)) {
  $null = New-Item -ItemType Directory -Force -Path $resolvedStateDir
  Add-Step 'state_dir' 'ok' ("已创建 {0}" -f $resolvedStateDir)
} else {
  Add-Step 'state_dir' 'ok' $resolvedStateDir
}

$tokenOk = $false
if (Test-Path -LiteralPath $operatorTokenPath) {
  try {
    $existing = (Get-Content -LiteralPath $operatorTokenPath -Raw).Trim()
    $tokenOk = ($existing.Length -ge 16)
  } catch {
    $tokenOk = $false
  }
}

if (-not $tokenOk) {
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  $token = 'khy_' + [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  $tmpToken = Join-Path $resolvedStateDir 'operator.token.tmp'
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($tmpToken, $token + "`n", $utf8NoBom)
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $grant = "${identity}:(R,W)"
  $aclResult = Invoke-Native -Exe 'icacls' -Arguments @($tmpToken, '/inheritance:r', '/grant:r', $grant)
  if ($aclResult.code -ne 0) {
    Remove-Item -LiteralPath $tmpToken -Force -ErrorAction SilentlyContinue
    Add-Step 'operator_token' 'fail' ("icacls 失败，已回滚：{0}" -f $aclResult.output.Trim())
    Finish 1
  }
  Move-Item -LiteralPath $tmpToken -Destination $operatorTokenPath -Force
  Add-Step 'operator_token' 'ok' '缺失，已生成（32 字节随机，icacls 仅当前用户）。'
} else {
  Add-Step 'operator_token' 'ok' '已存在，复用（不打印内容）。'
}

# ── 已经运行？ ──────────────────────────────────────────────────────────────
function Read-Runtime {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try {
    $data = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    if ($null -eq $data) { return $null }
    if ($data.PSObject.Properties.Name -notcontains 'port') { return $null }
    $port = [int]$data.port
    if ($port -lt 1024 -or $port -gt 65535) { return $null }
    return $data
  } catch {
    return $null
  }
}

function Get-RuntimeProp {
  param($Object, [string]$Name, $Default = $null)
  if ($null -eq $Object) { return $Default }
  if ($Object.PSObject.Properties.Name -contains $Name) { return $Object.$Name }
  return $Default
}

function Test-Health {
  param([int]$Port, [int]$TimeoutMs = 1500)
  try {
    $request = [System.Net.HttpWebRequest]::Create(("http://127.0.0.1:{0}/health" -f $Port))
    $request.Proxy = $null
    $request.Timeout = $TimeoutMs
    $request.ReadWriteTimeout = $TimeoutMs
    $response = $request.GetResponse()
    try {
      $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
      try { $body = $reader.ReadToEnd() } finally { $reader.Dispose() }
      return ($response.StatusCode -eq [System.Net.HttpStatusCode]::OK -and $body -match '"ok"\s*:\s*true')
    } finally {
      $response.Dispose()
    }
  } catch {
    return $false
  }
}

function Get-LogTail {
  param([string]$LogPath, [int]$Lines = 20)
  if (-not (Test-Path -LiteralPath $LogPath)) { return '（没有 daemon.log）' }
  try {
    return ((Get-Content -LiteralPath $LogPath -Tail $Lines) -join "`n")
  } catch {
    return ("（读取 daemon.log 失败：{0}）" -f $_.Exception.Message)
  }
}

$runtimePath = Join-Path $resolvedStateDir 'runtime.json'
$logPath = Join-Path $resolvedStateDir 'daemon.log'
$Report.state_dir = $resolvedStateDir
$Report.runtime = $runtimePath

$runtime = Read-Runtime -Path $runtimePath
if ($runtime -and (Test-Health -Port ([int]$runtime.port))) {
  $existingPid = Get-RuntimeProp -Object $runtime -Name 'pid' -Default '?'
  Add-Step 'daemon' 'ok' ("已在运行：pid={0}, port={1}" -f $existingPid, $runtime.port)
  $Report.port = [int]$runtime.port
  $Report.pid = $existingPid
  Finish 0
}

# ── 启动 ────────────────────────────────────────────────────────────────────
Add-Step 'daemon' 'warn' '未检测到可用的 daemon，调用 node bin/cli.js start。'
$startResult = Invoke-Native -Exe $nodeExe -Arguments @($cli, 'start', '--json', '--state-dir', $resolvedStateDir)
$startOut = $startResult.output.Trim()
$startCode = $startResult.code
if (-not $Json -and $startOut) { Write-Host $startOut }

if ($startCode -eq 3) {
  Add-Step 'daemon' 'fail' 'CLI start 返回 3（daemon_unavailable）：进程未能写出 runtime.json，或 /health 未就绪。daemon.log 见下一行。'
  Add-Step 'daemon_log' 'warn' (Get-LogTail -LogPath $logPath)
  Finish 3
}
if ($startCode -ne 0) {
  Add-Step 'daemon' 'fail' ("CLI start 退出码 {0}。daemon.log 尾部：{1}" -f $startCode, (Get-LogTail -LogPath $logPath))
  Finish 1
}

if ($NoWait) {
  Add-Step 'daemon' 'warn' '已提交启动（-NoWait），未等待 /health；请稍后用 doctor.ps1 复核。'
  Finish 0
}

# ── 等待就绪 ────────────────────────────────────────────────────────────────
$deadline = (Get-Date).AddSeconds([Math]::Max(3, $TimeoutSec))
$ready = $false
$readyPid = '?'
$readyPort = 0
while ((Get-Date) -lt $deadline) {
  $runtime = Read-Runtime -Path $runtimePath
  if ($runtime -and (Test-Health -Port ([int]$runtime.port) -TimeoutMs 800)) {
    $ready = $true
    $readyPid = Get-RuntimeProp -Object $runtime -Name 'pid' -Default '?'
    $readyPort = [int]$runtime.port
    $Report.port = $readyPort
    $Report.pid = $readyPid
    break
  }
  Start-Sleep -Milliseconds 200
}

if ($ready) {
  Add-Step 'daemon' 'ok' ("已就绪：pid={0}, port={1}, state={2}" -f $readyPid, $readyPort, $resolvedStateDir)
  Add-Step 'next' 'warn' '下一步：scripts\doctor.ps1 检查 adb/reverse/手机文件/MCP 配置。'
  Finish 0
}

Add-Step 'daemon' 'fail' ("{0}s 内未就绪。daemon.log 尾部：{1}" -f $TimeoutSec, (Get-LogTail -LogPath $logPath))
Finish 1
