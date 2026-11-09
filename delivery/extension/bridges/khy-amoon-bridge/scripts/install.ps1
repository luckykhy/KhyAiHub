#requires -Version 5.1
<#
  scripts/install.ps1 — 一次性安装（KhyOS 接入 + 手机侧部署入口）

  做四件事：
    1. 检查 Node (>=22) 与 ADB（ADB 缺失只警告，不阻止 MCP 注册）；
    2. 创建 per-user 状态目录与 operator.token（icacls 限定当前用户；失败即回滚并退出）；
    3. 若 scripts/deploy-phone.js 存在，调用它推送手机侧文件（--serial/--rotate/--open-chat）；
    4. 自动发现 KhyOS（khy.js），执行 `khy mcp add amoon --scope ... -- <绝对路径> ...`。
       已存在同名 server 时不覆盖（除非显式 -Force），并打印回滚命令。

  不写 mcp.json 的其它 server，不启动 daemon，不探测手机，不打印 token。
  所有路径都按本机生成；DryRun 只打印计划，不落盘、不执行 khy。
#>
[CmdletBinding()]
param(
  [ValidateSet('user', 'project')]
  [string]$Scope = 'user',

  [string]$Serial = '',
  [string]$StateDir = '',
  [string]$KhyJs = '',

  [switch]$SkipMcp,
  [switch]$SkipPhone,
  [switch]$RotatePhoneToken,
  [switch]$OpenChat,
  [switch]$Force,
  [switch]$DryRun,
  [switch]$Json
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Node and adb emit UTF-8. PowerShell 5.1 otherwise decodes native stdout/stderr
# with the OEM code page, which turns Chinese bootstrap errors into mojibake.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

$script:Root = Split-Path -Parent $PSScriptRoot
$script:Report = [ordered]@{
  ok = $false
  command = 'install'
  scope = $Scope
  dry_run = [bool]$DryRun
  steps = @()
  rollback = @()
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

function Fail {
  param([string]$Name, [string]$Detail)
  Add-Step -Name $Name -Level 'fail' -Detail $Detail
  $script:Report.ok = $false
  if ($Json) {
    $script:Report | ConvertTo-Json -Depth 8
  }
  exit 1
}

function Write-Plan {
  param([string]$Text)
  if (-not $Json) {
    Write-Host ("  · {0}" -f $Text) -ForegroundColor DarkGray
  }
}

<#
  Run a native command and capture BOTH streams without letting stderr turn
  into a terminating error. PowerShell 5.1 + $ErrorActionPreference='Stop' +
  `2>&1` converts native stderr into ErrorRecords and throws; khy/adb/icacls
  all write progress or warnings to stderr, so every capture goes through here.
#>
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

# ── 1. Node ────────────────────────────────────────────────────────────────
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Fail 'node' '未找到 node。请安装 Node >= 22 并加入 PATH（或设置 KHY_NODE）。'
}
$nodeExe = $nodeCmd.Source
if (-not $nodeExe -and $nodeCmd.PSObject.Properties.Name -contains 'Path') {
  $nodeExe = $nodeCmd.Path
}
if (-not $nodeExe) {
  Fail 'node' '无法解析 node 可执行文件路径。'
}
$nodeVersionResult = Invoke-Native -Exe $nodeExe -Arguments @('-v')
$nodeVersion = $nodeVersionResult.output.Trim()
if ($nodeVersion -notmatch '^v(\d+)\.') {
  Fail 'node' ("无法解析 node 版本：{0}" -f $nodeVersion)
}
$nodeMajor = [int]$Matches[1]
if ($nodeMajor -lt 22) {
  Fail 'node' ("Node {0} 低于要求（>=22）。" -f $nodeVersion)
}
Add-Step 'node' 'ok' ("{0}（{1}）" -f $nodeExe, $nodeVersion)
Write-Plan ("MCP server 将通过 `"{0}`" 启动。" -f $nodeExe)

# ── 2. ADB（缺失只警告） ────────────────────────────────────────────────────
function Resolve-Adb {
  param([string]$Root)
  if ($env:KHY_ADB -and (Test-Path -LiteralPath $env:KHY_ADB)) {
    return (Resolve-Path -LiteralPath $env:KHY_ADB).Path
  }
  $cmd = Get-Command adb -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @(
    # 便携工具目录由环境变量指路：KHY_ADB_ROOT=<含 platform-tools 的目录>。
    # 原来这里写死了作者机器上的 'D:\Portable\Tools\platform-tools\adb.exe'
    # —— 换台机器就不成立（守卫 RUNTIME-001 / Rule 1c 判的就是它）。
    $(if ($env:KHY_ADB_ROOT) { Join-Path $env:KHY_ADB_ROOT 'adb.exe' } else { $null }),
    (Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'),
    (Join-Path $env:USERPROFILE 'AppData\Local\Android\Sdk\platform-tools\adb.exe')
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  return $null
}

$adbExe = Resolve-Adb -Root $script:Root
if ($adbExe) {
  $adbVersionResult = Invoke-Native -Exe $adbExe -Arguments @('version')
$adbVersion = (($adbVersionResult.output -split "`r?`n") | Select-Object -First 1).Trim()
  Add-Step 'adb' 'ok' ("{0}（{1}）" -f $adbExe, $adbVersion)
} else {
  Add-Step 'adb' 'warn' '未找到 adb（PATH / D:\Portable\Tools\platform-tools\adb.exe）。MCP 注册可继续，手机部署会跳过。'
}

# ── 3. 状态目录与 operator token ────────────────────────────────────────────
function Resolve-StateDirPath {
  param([string]$Override)
  if ($Override) { return [System.IO.Path]::GetFullPath($Override) }
  if ($env:KHY_AMOON_HOME -and $env:KHY_AMOON_HOME.Trim()) {
    return [System.IO.Path]::GetFullPath($env:KHY_AMOON_HOME.Trim())
  }
  if ($env:LOCALAPPDATA -and $env:LOCALAPPDATA.Trim()) {
    return (Join-Path $env:LOCALAPPDATA 'khy-amoon-bridge')
  }
  return (Join-Path $HOME 'AppData\Local\khy-amoon-bridge')
}

$resolvedStateDir = Resolve-StateDirPath -Override $StateDir
$operatorTokenPath = Join-Path $resolvedStateDir 'operator.token'

if (-not $DryRun) {
  $null = New-Item -ItemType Directory -Force -Path $resolvedStateDir
  $subDirs = @('audit', 'jobs', 'idempotency', 'outbox', 'replies', 'spool', 'spool\screenshots', 'phone-cwd', 'probe')
  foreach ($sub in $subDirs) {
    $null = New-Item -ItemType Directory -Force -Path (Join-Path $resolvedStateDir $sub)
  }
  Add-Step 'state_dir' 'ok' $resolvedStateDir
} else {
  Add-Step 'state_dir' 'warn' ("DryRun：将创建 {0} 及其子目录。" -f $resolvedStateDir)
}

if ($env:KHY_AMOON_HOME -and -not $StateDir) {
  Add-Step 'state_dir_per_user' 'warn' 'KHY_AMOON_HOME 覆盖了 per-user 默认目录；若指向共享目录，会破坏单例与 token 隔离。'
}

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

function Set-UserOnlyAcl {
  param([string]$Path)
  $grant = "${identity}:(R,W)"
  $result = Invoke-Native -Exe 'icacls' -Arguments @($Path, '/inheritance:r', '/grant:r', $grant)
  if ($result.code -ne 0) {
    throw ("icacls 失败：{0}" -f $result.output.Trim())
  }
}

$tokenExists = Test-Path -LiteralPath $operatorTokenPath
$tokenValid = $false
if ($tokenExists) {
  try {
    $existing = (Get-Content -LiteralPath $operatorTokenPath -Raw).Trim()
    $tokenValid = ($existing.Length -ge 16)
  } catch {
    $tokenValid = $false
  }
}

if ($tokenValid) {
  Add-Step 'operator_token' 'ok' ("已存在（长度 {0}），复用；不打印内容。" -f $existing.Length)
} else {
  if ($DryRun) {
    Add-Step 'operator_token' 'warn' '将生成新的 operator.token（DryRun 未写入）。'
  } else {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $token = 'khy_' + [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    $tmpToken = Join-Path $resolvedStateDir 'operator.token.tmp'
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($tmpToken, $token + "`n", $utf8NoBom)
    try {
      Set-UserOnlyAcl -Path $tmpToken
      Move-Item -LiteralPath $tmpToken -Destination $operatorTokenPath -Force
    } catch {
      Remove-Item -LiteralPath $tmpToken -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $operatorTokenPath -Force -ErrorAction SilentlyContinue
      Fail 'operator_token' ("生成/加 ACL 失败，已回滚：{0}" -f $_.Exception.Message)
    }
    $aclOk = $false
    try {
      $rules = (Get-Acl -LiteralPath $operatorTokenPath).Access
      $identities = @($rules | ForEach-Object { $_.IdentityReference.Value })
      $aclOk = ($identities.Count -eq 1 -and $identities[0] -eq $identity)
    } catch {
      $aclOk = $false
    }
    if (-not $aclOk) {
      Remove-Item -LiteralPath $operatorTokenPath -Force -ErrorAction SilentlyContinue
      Fail 'operator_token' 'ACL 校验未通过（NTFS 上 fs.chmod 无效，必须依赖 icacls）；已删除 token 并中止。'
    }
    Add-Step 'operator_token' 'ok' '已生成（32 字节随机，长度 47），icacls 仅当前用户。'
  }
}

$Report.operator_token_path = $operatorTokenPath

# ── 4. 手机侧部署（优先 deploy-phone.js，其次 lib/bootstrap.js） ────────────
$deployScript = Join-Path $script:Root 'scripts\deploy-phone.js'
$bootstrapModule = Join-Path $script:Root 'lib\bootstrap.js'
$resolvedSerial = $Serial
if (-not $resolvedSerial -and $adbExe) {
  try {
    $devicesResult = Invoke-Native -Exe $adbExe -Arguments @('devices', '-l')
    $devicesOut = $devicesResult.output
    $serials = @()
    foreach ($line in ($devicesOut -split "`r?`n")) {
      $trimmed = $line.Trim()
      if (-not $trimmed -or $trimmed.StartsWith('List of devices')) { continue }
      # mDNS instance names may contain spaces; split on the first state token.
      if ($trimmed -match '^(.*?)\s+(no permissions|device|offline|unauthorized|recovery|sideload|bootloader)\s*($|\s)') {
        if ($Matches[2] -eq 'device') { $serials += $Matches[1].Trim() }
      }
    }
    if ($serials.Count -eq 1) { $resolvedSerial = $serials[0] }
    elseif ($serials.Count -gt 1) {
      Add-Step 'device' 'warn' ("检测到多台设备：{0}。请用 -Serial 显式指定。" -f ($serials -join ', '))
    } else {
      Add-Step 'device' 'warn' '未检测到已授权设备；手机侧部署会跳过。'
    }
  } catch {
    Add-Step 'device' 'warn' ("adb devices 失败：{0}" -f $_.Exception.Message)
  }
} elseif ($resolvedSerial) {
  Add-Step 'device' 'ok' ("使用显式 serial：{0}" -f $resolvedSerial)
}

function Resolve-PhonePort {
  param([string]$StatePath)
  $port = 18765
  if ($env:KHY_AMOON_PORT -match '^\d+$') { $port = [int]$env:KHY_AMOON_PORT }
  $runtimeFile = Join-Path $StatePath 'runtime.json'
  if (Test-Path -LiteralPath $runtimeFile) {
    try {
      $rt = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
      if ($null -ne $rt -and $rt.PSObject.Properties.Name -contains 'port') {
        $candidate = [int]$rt.port
        if ($candidate -ge 1024 -and $candidate -le 65535) { $port = $candidate }
      }
    } catch {
      # keep the default
    }
  }
  return $port
}

if ($SkipPhone) {
  Add-Step 'phone_deploy' 'warn' '已通过 -SkipPhone 跳过。'
} elseif (-not $adbExe -or -not $resolvedSerial) {
  Add-Step 'phone_deploy' 'warn' '缺少 adb 或设备 serial；已跳过手机侧文件部署。'
} elseif (Test-Path -LiteralPath $deployScript) {
  $deployArgs = @($deployScript, '--serial', $resolvedSerial)
  if ($RotatePhoneToken) { $deployArgs += '--rotate' }
  if ($OpenChat) { $deployArgs += '--open-chat' }
  if ($DryRun) {
    Add-Step 'phone_deploy' 'warn' ("DryRun：将执行 node {0}" -f ($deployArgs -join ' '))
  } else {
    Write-Plan ("node {0}" -f ($deployArgs -join ' '))
    $deployResult = Invoke-Native -Exe $nodeExe -Arguments $deployArgs
    if ($deployResult.code -ne 0) {
      Add-Step 'phone_deploy' 'warn' ("deploy-phone.js 退出码 {0}；MCP 注册继续。输出：{1}" -f $deployResult.code, $deployResult.output.Trim())
    } else {
      Add-Step 'phone_deploy' 'ok' '手机侧文件已推送（仍需 amoon 自己完成 Phase 0 探测才算双向）。'
      if (-not $Json) { Write-Host $deployResult.output }
    }
  }
} elseif (Test-Path -LiteralPath $bootstrapModule) {
  $phonePort = Resolve-PhonePort -StatePath $resolvedStateDir
  $needPhoneToken = $false
  if ($RotatePhoneToken) {
    $needPhoneToken = $true
  } else {
    $tokenCheck = Invoke-Native -Exe $adbExe -Arguments @('-s', $resolvedSerial, 'shell', 'test -f /sdcard/khy-amoon-bridge/token.txt && echo yes || echo no')
    $needPhoneToken = -not ($tokenCheck.output -match 'yes')
  }
  $hasAuthModule = Test-Path -LiteralPath (Join-Path $script:Root 'lib\auth.js')
  if ($needPhoneToken -and -not $hasAuthModule) {
    Add-Step 'phone_deploy' 'warn' '需要 phone token，但 lib/auth.js 不存在；将不推送 token.txt。'
    $needPhoneToken = $false
  }

  $bootstrapDriver = @'
const path = require('path');
const extRoot = process.argv[1];
const stateDir = process.argv[2];
const serial = process.argv[3];
const wantToken = process.argv[4] === '1';
const port = Number(process.argv[5]);
const force = process.argv[6] === '1';
const { loadConfig } = require(path.join(extRoot, 'lib', 'config.js'));
const { createLogger } = require(path.join(extRoot, 'lib', 'logger.js'));
const { createAdbTransport } = require(path.join(extRoot, 'lib', 'adb.js'));
const { createBootstrap } = require(path.join(extRoot, 'lib', 'bootstrap.js'));
const config = loadConfig({ stateDir });
const logger = createLogger({ level: 'error', file: null, stderr: process.stderr });
const adb = createAdbTransport({ config, serial, logger });
let token = null;
let store = null;
let issued = null;
if (wantToken) {
  const { createTokenStore } = require(path.join(extRoot, 'lib', 'auth.js'));
  store = createTokenStore({ config, logger });
  // Two-phase: issue first; only commit after bootstrap confirms the push.
  issued = store.issuePhone();
  token = issued.token;
}
const bootstrap = createBootstrap({ config, adb, assetsDir: path.join(extRoot, 'phone'), logger });
bootstrap.run({ token, port, force }).then((report) => {
  let rotating = false;
  if (issued && report.token && report.token.pushed) {
    store.commitPhoneRotation(issued.record.id);
    rotating = true;
  }
  report.rotation_committed = rotating;
  bootstrap.dispose();
  process.stdout.write(JSON.stringify(report) + '\n');
  process.exit(report.ok ? 0 : 1);
}).catch((err) => {
  bootstrap.dispose();
  process.stderr.write(((err && err.message) || String(err)) + '\n');
  process.exit(1);
});
'@

  $bootstrapArgs = @(
    '-e', $bootstrapDriver, $script:Root, $resolvedStateDir, $resolvedSerial,
    $(if ($needPhoneToken) { '1' } else { '0' }),
    [string]$phonePort,
    $(if ($Force) { '1' } else { '0' })
  )
  if ($DryRun) {
    Add-Step 'phone_deploy' 'warn' ("DryRun：将调用 lib/bootstrap.js 推送 phone/README.md、phone/tools.json、phone/kb、port.txt；port={0}；token={1}。" -f $phonePort, $(if ($needPhoneToken) { 'rotate+push' } else { 'keep existing' }))
  } else {
    Write-Plan ("node -e <bootstrap> <extRoot> <stateDir> <serial> port={0}" -f $phonePort)
    $bootResult = Invoke-Native -Exe $nodeExe -Arguments $bootstrapArgs
    $jsonLine = @($bootResult.output -split "`r?`n" | Where-Object { $_.Trim().StartsWith('{') }) | Select-Object -Last 1
    $bootReport = $null
    if ($jsonLine) {
      try { $bootReport = $jsonLine | ConvertFrom-Json } catch { $bootReport = $null }
    }
    if ($bootResult.code -eq 0 -and $null -ne $bootReport -and $bootReport.ok -eq $true) {
      $changed = 0
      if ($bootReport.PSObject.Properties.Name -contains 'files') {
        $changed = @($bootReport.files | Where-Object { $_.changed -eq $true }).Count
      }
      Add-Step 'phone_deploy' 'ok' ("bootstrap 完成：{0} 个文件变更；port={1}；token={2}。" -f $changed, $phonePort, $(if ($needPhoneToken) { '已轮换并推送' } else { '保持现状' }))
    } else {
      $errText = $bootResult.output.Trim()
      if ($null -ne $bootReport -and $bootReport.PSObject.Properties.Name -contains 'errors') {
        $errText = (@($bootReport.errors | ForEach-Object { "{0}: {1}" -f $_.code, $_.message }) -join '; ')
      }
      Add-Step 'phone_deploy' 'warn' ("bootstrap 未完全成功（退出码 {0}）；MCP 注册继续。{1}" -f $bootResult.code, $errText)
    }
  }
} else {
  Add-Step 'phone_deploy' 'warn' '既没有 scripts/deploy-phone.js 也没有 lib/bootstrap.js；已跳过手机侧文件部署。'
}

# ── 5. KhyOS 发现与 MCP 注册 ────────────────────────────────────────────────
$helperPath = Join-Path $script:Root 'lib\khy-tools.js'
if (-not (Test-Path -LiteralPath $helperPath)) {
  Fail 'khy_tools' ("缺少 {0}；无法生成绝对路径的 MCP 入口。" -f $helperPath)
}

$khyJsPath = $KhyJs
if (-not $khyJsPath) {
  $discoverJs = @'
const k = require(process.argv[1]);
const found = k.findKhyOsInstallation({ extRoot: process.argv[2], env: process.env });
if (found) console.log(JSON.stringify(found)); else process.exit(2);
'@
  $discoverResult = Invoke-Native -Exe $nodeExe -Arguments @('-e', $discoverJs, $helperPath, $script:Root)
  $discovered = $discoverResult.output.Trim()
  if ($discoverResult.code -eq 0 -and $discovered) {
    try {
      $found = $discovered | ConvertFrom-Json
      $khyJsPath = $found.khyJs
    } catch {
      $khyJsPath = ''
    }
  }
}

if ($khyJsPath) {
  if (-not (Test-Path -LiteralPath $khyJsPath)) {
    Fail 'khy_js' ("指定的 khy.js 不存在：{0}" -f $khyJsPath)
  }
  $khyJsPath = (Resolve-Path -LiteralPath $khyJsPath).Path
  Add-Step 'khy_js' 'ok' $khyJsPath
} else {
  Add-Step 'khy_js' 'warn' '未自动发现 KhyOS（khy.js）。可用 -KhyJs 指定，或稍后手工执行注册命令。'
}

$entryJs = @'
const k = require(process.argv[1]);
const entry = k.getMcpServerEntry({
  nodePath: process.argv[2],
  extRoot: process.argv[3],
  stateDir: process.argv[4],
  khyJs: process.argv[5] || null
});
console.log(JSON.stringify(entry));
'@
$entryResult = Invoke-Native -Exe $nodeExe -Arguments @('-e', $entryJs, $helperPath, $nodeExe, $script:Root, $resolvedStateDir, $khyJsPath)
$entryRaw = $entryResult.output.Trim()
if ($entryResult.code -ne 0 -or -not $entryRaw) {
  Fail 'mcp_entry' ("生成 MCP 入口失败：{0}" -f $entryRaw)
}
$entry = $entryRaw | ConvertFrom-Json
$entryArgs = @($entry.args | ForEach-Object { [string]$_ })
Add-Step 'mcp_entry' 'ok' ("{0} {1}" -f $entry.command, ($entryArgs -join ' '))

if ($SkipMcp) {
  Add-Step 'mcp_register' 'warn' '已通过 -SkipMcp 跳过注册。'
} elseif (-not $khyJsPath) {
  Add-Step 'mcp_register' 'warn' 'KhyOS 未发现；请先设置 KHY_JS 或使用 -KhyJs，再重新运行。'
} else {
  # 解析目标 mcp.json（不写；只用于“不覆盖已有配置”的判断）
  $userMcpJson = ''
  if ($env:KHY_DATA_HOME -and $env:KHY_DATA_HOME.Trim()) {
    $userMcpJson = Join-Path $env:KHY_DATA_HOME.Trim() 'mcp.json'
  } else {
    $khyRoot = [System.IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $khyJsPath) '..\..\..\..'))
    $userMcpJson = Join-Path $khyRoot 'works\data\khy\mcp.json'
  }
  if ($Scope -eq 'project') {
    $targetMcpJson = Join-Path (Get-Location).Path 'works\data\khy\mcp.json'
  } else {
    $targetMcpJson = $userMcpJson
  }
  $Report.mcp_json = $targetMcpJson

  $alreadyRegistered = $false
  if (Test-Path -LiteralPath $targetMcpJson) {
    try {
      $existingConfig = Get-Content -LiteralPath $targetMcpJson -Raw | ConvertFrom-Json
      if ($null -ne $existingConfig -and
          $existingConfig.PSObject.Properties.Name -contains 'mcpServers' -and
          $null -ne $existingConfig.mcpServers -and
          $existingConfig.mcpServers.PSObject.Properties.Name -contains 'amoon') {
        $alreadyRegistered = $true
      }
    } catch {
      Fail 'mcp_register' ("已有 mcp.json 无法解析（拒绝覆盖）：{0}" -f $targetMcpJson)
    }
  }

  $removeArgs = @('mcp', 'remove', 'amoon', '--scope', $Scope)
  $rollback = ('& {0} {1}' -f $nodeExe, (($khyJsPath + ' ' + ($removeArgs -join ' '))))
  $script:Report.rollback += $rollback

  if ($alreadyRegistered -and -not $Force) {
    Add-Step 'mcp_register' 'warn' ("mcp.json 中已存在 amoon（{0}）；未覆盖。需要替换请加 -Force，或先回滚。" -f $targetMcpJson)
  } else {
    $addArgs = @('mcp', 'add', 'amoon', '--scope', $Scope, '--', $entry.command) + $entryArgs
    if ($DryRun) {
      Add-Step 'mcp_register' 'warn' ("DryRun：将执行 & `"{0}`" `"{1}`" {2}" -f $nodeExe, $khyJsPath, ($addArgs -join ' '))
    } else {
      Write-Plan ("& `"{0}`" `"{1}`" {2}" -f $nodeExe, $khyJsPath, ($addArgs -join ' '))
      $addResult = Invoke-Native -Exe $nodeExe -Arguments (@($khyJsPath) + $addArgs)
      if ($addResult.code -ne 0) {
        Fail 'mcp_register' ("khy mcp add 失败（退出码 {0}）：{1}" -f $addResult.code, $addResult.output.Trim())
      }
      if (-not $Json) { Write-Host $addResult.output }

      $verified = $false
      try {
        $newConfig = Get-Content -LiteralPath $targetMcpJson -Raw | ConvertFrom-Json
        if ($null -ne $newConfig -and
            $newConfig.PSObject.Properties.Name -contains 'mcpServers' -and
            $null -ne $newConfig.mcpServers -and
            $newConfig.mcpServers.PSObject.Properties.Name -contains 'amoon') {
          $registered = $newConfig.mcpServers.amoon
          $regCommand = ''
          if ($registered.PSObject.Properties.Name -contains 'command') { $regCommand = [string]$registered.command }
          $regArgValue = @()
          if ($registered.PSObject.Properties.Name -contains 'args') { $regArgValue = @($registered.args) }
          $regArgs = @($regArgValue | ForEach-Object { [string]$_ })
          $verified = ($regCommand -eq $entry.command -and ($regArgs -join "`n") -eq ($entryArgs -join "`n"))
        }
      } catch {
        $verified = $false
      }
      if ($verified) {
        Add-Step 'mcp_register' 'ok' ("已写入 {0}（amoon，scope={1}）。" -f $targetMcpJson, $Scope)
      } else {
        Add-Step 'mcp_register' 'warn' 'khy mcp add 退出码为 0，但回读 mcp.json 未得到完全一致的入口；请用 -Json 或手工核对。'
      }
    }
  }

  Add-Step 'mcp_verify_hint' 'warn' '`khy mcp test` 只做 connect+listTools，不能当验收；真实调用见 README 的 khy -p 一节。'
  Add-Step 'rollback' 'ok' $rollback
}

$script:Report.ok = $true
if ($Json) {
  $script:Report | ConvertTo-Json -Depth 8
} else {
  Write-Host ''
  Write-Host '安装步骤完成。下一步：' -ForegroundColor Cyan
  Write-Host '  1) scripts\start.ps1          启动 daemon（后台单例；失败会打印 daemon.log 尾部）'
  Write-Host '  2) scripts\doctor.ps1         环境/设备/reverse/token/MCP 配置自检'
  Write-Host '  3) 在手机 amoon 中按 docs\PHASE0.md 完成三项探测后才宣称双向'
  Write-Host '  4) 验收必须用真实 tools/call：khy -p "调用 mcp__amoon__ping 并只返回 pong" --allowedTools mcp__amoon__ping --output-format json --max-turns 2'
}
exit 0
