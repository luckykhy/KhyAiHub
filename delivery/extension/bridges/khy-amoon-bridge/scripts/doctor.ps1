#requires -Version 5.1
<#
  scripts/doctor.ps1 — 只读诊断

  检查项：
    node / 状态目录 / operator token（含 ACL）/ daemon(runtime.json+/health)
    adb / 设备与 serial / reverse 映射 / 手机信箱文件 / KhyOS MCP 注册 / Phase 0 能力状态

  不写任何文件、不启动 daemon、不注册 MCP、不调用模型。
  `adb devices` 可能唤醒 adb server，这是 adb 自身行为；本脚本不执行 kill-server。
  退出码：存在 fail → 1；否则 0（warn 不影响退出码）。
#>
[CmdletBinding()]
param(
  [string]$Serial = '',
  [string]$StateDir = '',
  [switch]$Json
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Node/adb emit UTF-8; avoid OEM-code-page mojibake when capturing their output.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

$script:Root = Split-Path -Parent $PSScriptRoot
$script:Checks = @()

function Add-Check {
  param([string]$Name, [string]$Level, [string]$Detail)
  $script:Checks += [ordered]@{ name = $Name; level = $Level; detail = $Detail }
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

function Resolve-StateDirPath {
  param([string]$Override)
  if ($Override) { return [System.IO.Path]::GetFullPath($Override) }
  if ($env:KHY_AMOON_HOME -and $env:KHY_AMOON_HOME.Trim()) {
    return [System.IO.Path]::GetFullPath($env:KHY_AMOON_HOME.Trim())
  }
  if ($env:LOCALAPPDATA -and $env:LOCALAPPDATA.Trim()) { return (Join-Path $env:LOCALAPPDATA 'khy-amoon-bridge') }
  return (Join-Path $HOME 'AppData\Local\khy-amoon-bridge')
}

function Resolve-Adb {
  if ($env:KHY_ADB -and (Test-Path -LiteralPath $env:KHY_ADB)) {
    return (Resolve-Path -LiteralPath $env:KHY_ADB).Path
  }
  $cmd = Get-Command adb -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @(
    # 便携工具目录由环境变量指路：KHY_ADB_ROOT=<含 platform-tools 的目录>。
    # 原来这里写死了作者机器上的绝对路径 —— 换台机器就不成立
    # （守卫 RUNTIME-001 / Rule 1c 判的就是它）。
    $(if ($env:KHY_ADB_ROOT) { Join-Path $env:KHY_ADB_ROOT 'adb.exe' } else { $null }),
    (Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'),
    (Join-Path $env:USERPROFILE 'AppData\Local\Android\Sdk\platform-tools\adb.exe')
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  return $null
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

function Read-JsonFile {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try {
    $raw = Get-Content -LiteralPath $Path -Raw
    if ($null -eq $raw -or -not $raw.Trim()) { return $null }
    return ($raw | ConvertFrom-Json)
  } catch {
    return $null
  }
}

function Get-Prop {
  param($Object, [string]$Name, $Default = $null)
  if ($null -eq $Object) { return $Default }
  if ($Object.PSObject.Properties.Name -contains $Name) { return $Object.$Name }
  return $Default
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

# ── 1. Node ────────────────────────────────────────────────────────────────
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$nodeExe = $null
if (-not $nodeCmd) {
  Add-Check 'node' 'fail' '未找到 node（需要 >= 22）。khy_ask/MCP/安装脚本都不可用。'
} else {
  $nodeExe = $nodeCmd.Source
  if (-not $nodeExe -and $nodeCmd.PSObject.Properties.Name -contains 'Path') { $nodeExe = $nodeCmd.Path }
  $nodeVersion = (Invoke-Native -Exe $nodeExe -Arguments @('-v')).output.Trim()
  if ($nodeVersion -match '^v(\d+)\.' -and [int]$Matches[1] -ge 22) {
    Add-Check 'node' 'ok' ("{0}（{1}）" -f $nodeExe, $nodeVersion)
  } else {
    Add-Check 'node' 'fail' ("Node 版本不满足 >=22：{0}" -f $nodeVersion)
  }
}

# ── 2. 状态目录与 token ────────────────────────────────────────────────────
$resolvedStateDir = Resolve-StateDirPath -Override $StateDir
$stateExists = Test-Path -LiteralPath $resolvedStateDir
$stateIsDefault = -not ($StateDir -or ($env:KHY_AMOON_HOME -and $env:KHY_AMOON_HOME.Trim()))
if ($stateExists) {
  Add-Check 'state_dir' 'ok' ("{0}（per-user 默认：{1}）" -f $resolvedStateDir, $stateIsDefault)
} else {
  Add-Check 'state_dir' 'warn' ("{0} 不存在（运行 scripts/install.ps1 创建）。" -f $resolvedStateDir)
}

$tokenPath = Join-Path $resolvedStateDir 'operator.token'
if (-not (Test-Path -LiteralPath $tokenPath)) {
  Add-Check 'operator_token' 'fail' 'operator.token 缺失；daemon 会 fail-closed 返回 auth_unavailable。'
} else {
  $tokenLength = 0
  try { $tokenLength = ((Get-Content -LiteralPath $tokenPath -Raw) | Out-String).Trim().Length } catch { $tokenLength = 0 }
  if ($tokenLength -ge 16) {
    Add-Check 'operator_token' 'ok' ("存在，长度 {0}（不打印内容）。" -f $tokenLength)
  } else {
    Add-Check 'operator_token' 'fail' ("存在但长度 {0} < 16；daemon 会拒绝。" -f $tokenLength)
  }

  try {
    $acl = Get-Acl -LiteralPath $tokenPath
    $rules = @($acl.Access)
    $inherited = @($rules | Where-Object { $_.IsInherited })
    $identities = @($rules | ForEach-Object { $_.IdentityReference.Value } | Select-Object -Unique)
    $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $others = @($identities | Where-Object { $_ -ne $me })
    if ($inherited.Count -gt 0) {
      Add-Check 'token_acl' 'warn' ("仍存在继承 ACE（{0} 条）；NTFS 上 fs.chmod 无效，应使用 icacls /inheritance:r。" -f $inherited.Count)
    } elseif ($others.Count -gt 0) {
      Add-Check 'token_acl' 'warn' ("除当前用户外还有：{0}。建议 icacls /inheritance:r /grant:r `"{1}:(R,W)`"。" -f ($others -join ', '), $me)
    } else {
      Add-Check 'token_acl' 'ok' '仅当前用户可读写。'
    }
  } catch {
    Add-Check 'token_acl' 'warn' ("无法读取 ACL：{0}" -f $_.Exception.Message)
  }
}

# ── 3. daemon ──────────────────────────────────────────────────────────────
$runtimePath = Join-Path $resolvedStateDir 'runtime.json'
$runtime = Read-JsonFile -Path $runtimePath
$runtimePortRaw = Get-Prop -Object $runtime -Name 'port'
$runtimePort = 0
if ($null -eq $runtime -or $null -eq $runtimePortRaw) {
  Add-Check 'daemon' 'warn' '没有可用的 runtime.json（daemon 未启动，或模块 A 尚未落地）。'
} else {
  try { $runtimePort = [int]$runtimePortRaw } catch { $runtimePort = 0 }
  if ($runtimePort -lt 1024 -or $runtimePort -gt 65535) {
    Add-Check 'daemon' 'fail' ("runtime.json 的 port 非法：{0}" -f $runtimePortRaw)
  } elseif (Test-Health -Port $runtimePort) {
    $pidValue = Get-Prop -Object $runtime -Name 'pid'
    $pidText = if ($null -ne $pidValue) { [string]$pidValue } else { '?' }
    Add-Check 'daemon' 'ok' ("/health 200：pid={0}, port={1}" -f $pidText, $runtimePort)
  } else {
    Add-Check 'daemon' 'fail' ("runtime.json 存在（port={0}）但 /health 不通；可能已崩溃或端口被占用。" -f $runtimePort)
  }
}

$capabilityPath = Join-Path $resolvedStateDir 'capability.json'
$capability = Read-JsonFile -Path $capabilityPath
if ($null -eq $capability) {
  Add-Check 'phase0' 'warn' '没有 capability.json；amoon→PC 一律按 unverified（单向）处理。'
} else {
  $capStatus = [string](Get-Prop -Object $capability -Name 'status' -Default 'unverified')
  $capLevel = if ($capStatus -eq 'verified') { 'ok' } else { 'warn' }
  Add-Check 'phase0' $capLevel ("amoon→PC 能力状态：{0}（verified 之前不得宣称双向）。" -f $capStatus)
}

# ── 4. ADB / 设备 / reverse / 手机文件 ─────────────────────────────────────
$adbExe = Resolve-Adb
if (-not $adbExe) {
  Add-Check 'adb' 'fail' '未找到 adb（PATH / D:\Portable\Tools\platform-tools\adb.exe / KHY_ADB）。'
  $adbExe = $null
} else {
  $adbVersionResult = Invoke-Native -Exe $adbExe -Arguments @('version')
  $adbVersion = (($adbVersionResult.output -split "`r?`n") | Select-Object -First 1).Trim()
  Add-Check 'adb' 'ok' ("{0}（{1}）" -f $adbExe, $adbVersion)
}

$resolvedSerial = $Serial
if (-not $resolvedSerial -and $env:KHY_AMOON_SERIAL) { $resolvedSerial = $env:KHY_AMOON_SERIAL }

$devices = @()
if ($adbExe) {
  try {
    $devicesOut = (Invoke-Native -Exe $adbExe -Arguments @('devices', '-l')).output
    foreach ($line in ($devicesOut -split "`r?`n")) {
      $trimmed = $line.Trim()
      if (-not $trimmed -or $trimmed.StartsWith('List of devices')) { continue }
      if ($trimmed.StartsWith('adb server') -or $trimmed.StartsWith('* daemon')) { continue }
      # mDNS instance names may contain spaces, e.g.
      #   adb-ZYPZ...-R9QdlL (2)._adb-tls-connect._tcp.  device product:...
      # so split on the first state token instead of whitespace.
      if ($trimmed -match '^(.*?)\s+(no permissions|device|offline|unauthorized|recovery|sideload|bootloader)\s*($|\s)') {
        $devices += [ordered]@{ serial = $Matches[1].Trim(); state = $Matches[2] }
      }
    }
  } catch {
    Add-Check 'devices' 'fail' ("adb devices 失败：{0}" -f $_.Exception.Message)
  }

  if ($devices.Count -eq 0) {
    Add-Check 'devices' 'warn' '没有已授权设备。请连接 USB 或完成无线调试配对。'
  } elseif ($devices.Count -eq 1 -and -not $resolvedSerial) {
    $resolvedSerial = $devices[0].serial
    Add-Check 'devices' 'ok' ("1 台：{0}（{1}）" -f $resolvedSerial, $devices[0].state)
  } elseif (-not $resolvedSerial) {
    $listText = ($devices | ForEach-Object { "{0}({1})" -f $_.serial, $_.state }) -join ', '
    Add-Check 'devices' 'warn' ("检测到 {0} 台设备：{1}。没有 -s 的 adb 会报 more than one device；请用 -Serial 指定。" -f $devices.Count, $listText)
  } else {
    Add-Check 'devices' 'ok' ("显式 serial：{0}；共检测到 {1} 台。" -f $resolvedSerial, $devices.Count)
  }
}

if ($adbExe -and $resolvedSerial) {
  $stateText = ''
  try { $stateText = (Invoke-Native -Exe $adbExe -Arguments @('-s', $resolvedSerial, 'get-state')).output.Trim() } catch { $stateText = 'error' }
  if ($stateText -eq 'device') {
    Add-Check 'device_state' 'ok' ("{0} → device" -f $resolvedSerial)
  } else {
    Add-Check 'device_state' 'fail' ("{0} → {1}（不是 device）" -f $resolvedSerial, $stateText)
  }

  try {
    $revOut = (Invoke-Native -Exe $adbExe -Arguments @('-s', $resolvedSerial, 'reverse', '--list')).output
    $revLines = @($revOut -split "`r?`n" | Where-Object { $_.Trim() })
    $ports = @()
    foreach ($line in $revLines) {
      if ($line -match 'tcp:(\d+)\s+tcp:(\d+)') { $ports += [int]$Matches[1] }
    }
    if ($ports.Count -eq 0) {
      Add-Check 'reverse' 'warn' 'reverse 列表为空；手机无法访问 127.0.0.1:<port>（daemon 启动后应自动建立）。'
    } else {
      $expected = if ($runtimePort -gt 0) { $runtimePort } else { 18765 }
      if ($ports -contains $expected) {
        Add-Check 'reverse' 'ok' ("tcp:{0} → 已映射。列表：{1}" -f $expected, ($revLines -join ' | '))
      } else {
        Add-Check 'reverse' 'warn' ("有 reverse 但端口不是 {0}：{1}" -f $expected, ($revLines -join ' | '))
      }
    }
  } catch {
    Add-Check 'reverse' 'warn' ("reverse --list 失败：{0}" -f $_.Exception.Message)
  }

  try {
    $lsResult = Invoke-Native -Exe $adbExe -Arguments @('-s', $resolvedSerial, 'shell', 'ls -1 /sdcard/khy-amoon-bridge')
    $lsOut = $lsResult.output
    if ($lsResult.code -ne 0) {
      Add-Check 'phone_files' 'warn' '手机上没有 /sdcard/khy-amoon-bridge（尚未部署，或 amoon 无存储权限）。'
    } else {
      $names = @($lsOut -split "`r?`n" | Where-Object { $_.Trim() } | ForEach-Object { $_.Trim() })
      # lib/bootstrap.js pushes README.md/tools.json/kb/port.txt (+ token.txt when
      # a phone token is supplied); config.json/token are the contract-compatible
      # alternatives that phone/kb prefers when present.
      $required = @('kb', 'tools.json', 'README.md')
      $missing = @($required | Where-Object { $names -notcontains $_ })
      $hasPort = ($names -contains 'port.txt') -or ($names -contains 'config.json')
      $hasToken = ($names -contains 'token.txt') -or ($names -contains 'token')
      if ($missing.Count -eq 0 -and $hasPort) {
        if ($hasToken) {
          Add-Check 'phone_files' 'ok' ("目录存在，关键文件齐全（port/token 均存在）。")
        } else {
          Add-Check 'phone_files' 'warn' '目录存在，但缺少 token.txt/token：HTTP 快通道不可用，文件慢通道仍可用（phone token 默认只读）。'
        }
      } elseif ($missing.Count -gt 0) {
        Add-Check 'phone_files' 'warn' ("目录存在，但缺少：{0}。请运行 scripts/install.ps1 或 deploy-phone.js。" -f ($missing -join ', '))
      } else {
        Add-Check 'phone_files' 'warn' '目录存在，但缺少 port.txt/config.json：手机不知道 daemon 端口。'
      }
    }
  } catch {
    Add-Check 'phone_files' 'warn' ("ls 手机目录失败：{0}" -f $_.Exception.Message)
  }
} else {
  Add-Check 'reverse' 'warn' '没有 adb 或 serial，跳过 reverse 检查。'
  Add-Check 'phone_files' 'warn' '没有 adb 或 serial，跳过手机文件检查。'
}

# ── 5. KhyOS MCP 注册 ──────────────────────────────────────────────────────
$khyJsPath = ''
if ($env:KHY_JS -and (Test-Path -LiteralPath $env:KHY_JS)) {
  $khyJsPath = (Resolve-Path -LiteralPath $env:KHY_JS).Path
} elseif ($env:KHY_HOME) {
  $candidate = Join-Path $env:KHY_HOME 'runtime\node\backend\bin\khy.js'
  if (Test-Path -LiteralPath $candidate) { $khyJsPath = (Resolve-Path -LiteralPath $candidate).Path }
}
if (-not $khyJsPath) {
  # 仓库内自带的 khy.js：按脚本自身位置往上找 runtime\node\backend\bin\khy.js。
  # 原来这里写死了作者机器上的 'D:\Portable\khy-os\...' —— 换台机器就找不到
  # （守卫 RUNTIME-001 / Rule 1c 判的就是它）。
  $repoGuess = Join-Path (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)))) 'runtime\node\backend\bin\khy.js'
  if (Test-Path -LiteralPath $repoGuess) {
    $khyJsPath = (Resolve-Path -LiteralPath $repoGuess).Path
  }
}

if (-not $khyJsPath) {
  Add-Check 'khy_js' 'warn' '未发现 KhyOS（khy.js）。设置 KHY_JS 后重试。'
  Add-Check 'mcp_config' 'warn' '无法定位 mcp.json（没有 khy.js）。'
} else {
  Add-Check 'khy_js' 'ok' $khyJsPath
  if ($env:KHY_DATA_HOME -and $env:KHY_DATA_HOME.Trim()) {
    $mcpJsonPath = Join-Path $env:KHY_DATA_HOME.Trim() 'mcp.json'
  } else {
    $khyRoot = [System.IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $khyJsPath) '..\..\..\..'))
    $mcpJsonPath = Join-Path $khyRoot 'works\data\khy\mcp.json'
  }

  $mcpConfig = Read-JsonFile -Path $mcpJsonPath
  $servers = Get-Prop -Object $mcpConfig -Name 'mcpServers'
  if ($null -eq $mcpConfig) {
    Add-Check 'mcp_config' 'warn' ("{0} 不存在或无法解析；尚未注册 amoon。" -f $mcpJsonPath)
  } elseif ($null -eq $servers -or $servers.PSObject.Properties.Name -notcontains 'amoon') {
    Add-Check 'mcp_config' 'warn' ("{0} 中没有 amoon；运行 scripts/install.ps1 注册。" -f $mcpJsonPath)
  } else {
    $amoon = $servers.amoon
    $typeText = [string](Get-Prop -Object $amoon -Name 'type' -Default 'stdio')
    $cmd = [string](Get-Prop -Object $amoon -Name 'command' -Default '')
    $argValue = Get-Prop -Object $amoon -Name 'args' -Default @()
    $argList = @()
    if ($null -ne $argValue) { $argList = @($argValue | ForEach-Object { [string]$_ }) }
    $disabled = ((Get-Prop -Object $amoon -Name 'disabled' -Default $false) -eq $true)
    $disabledText = ''
    if ($disabled) { $disabledText = ' [disabled]' }
    $detail = ("type={0}, command={1}, args={2}{3}" -f $typeText, $cmd, ($argList -join ' '), $disabledText)

    $entryOk = $true
    if ($nodeExe) {
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
      $expectedResult = Invoke-Native -Exe $nodeExe -Arguments @('-e', $entryJs, (Join-Path $script:Root 'lib\khy-tools.js'), $nodeExe, $script:Root, $resolvedStateDir, $khyJsPath)
      $expectedRaw = $expectedResult.output.Trim()
      if ($expectedResult.code -eq 0 -and $expectedRaw) {
        try {
          $expected = $expectedRaw | ConvertFrom-Json
          $expectedArgs = @($expected.args | ForEach-Object { [string]$_ })
          $entryOk = ($cmd -eq $expected.command -and ($argList -join "`n") -eq ($expectedArgs -join "`n"))
        } catch {
          $entryOk = $false
        }
      }
    }

    if ($disabled) {
      Add-Check 'mcp_config' 'warn' ("amoon 已注册但被禁用：{0}" -f $detail)
    } elseif ($entryOk) {
      Add-Check 'mcp_config' 'ok' ("amoon 已注册且入口一致：{0}" -f $detail)
    } else {
      Add-Check 'mcp_config' 'warn' ("amoon 已注册但入口与当前路径不一致（可能移动过目录）：{0}。用 -Force 重跑 install.ps1。" -f $detail)
    }
  }
}

# ── 6. 结论 ────────────────────────────────────────────────────────────────
$failCount = @($script:Checks | Where-Object { $_.level -eq 'fail' }).Count
$warnCount = @($script:Checks | Where-Object { $_.level -eq 'warn' }).Count
$notes = @(
  '`khy mcp test` 只做 connect+listTools，不执行 tools/call，不能当验收。',
  '真实验收（消耗模型 token）：khy -p "调用 mcp__amoon__ping 并只返回 pong" --allowedTools mcp__amoon__ping --output-format json --max-turns 2',
  'amoon→PC 必须由 amoon 自己完成 docs/PHASE0.md 的三项探测并写入 capability.json，才可宣称双向。',
  '本脚本不修改任何文件；上面的 warn 项需要人工处理。'
)

$result = [ordered]@{
  ok = ($failCount -eq 0)
  command = 'doctor'
  root = $script:Root
  state_dir = $resolvedStateDir
  checks = $script:Checks
  fail_count = $failCount
  warn_count = $warnCount
  notes = $notes
}

if ($Json) {
  $result | ConvertTo-Json -Depth 8
} else {
  Write-Host ''
  if ($failCount -gt 0) {
    Write-Host ("结论：{0} 个 fail，{1} 个 warn。桥不可用，请先处理 fail。" -f $failCount, $warnCount) -ForegroundColor Red
  } else {
    Write-Host ("结论：没有 fail，{0} 个 warn。基础环境通过；功能仍需按 README 的真机步骤验收。" -f $warnCount) -ForegroundColor Green
  }
  Write-Host '说明：' -ForegroundColor Cyan
  foreach ($note in $notes) { Write-Host ("  - {0}" -f $note) }
}

if ($failCount -gt 0) { exit 1 }
exit 0
