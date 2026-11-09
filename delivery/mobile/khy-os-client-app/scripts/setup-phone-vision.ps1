# setup-phone-vision.ps1 — let the phone use a vision model WITHOUT installing
# Ollama on the phone.
#
# WHY this script exists. The phone app needs a vision-capable endpoint to read
# the screen, and the obvious place to run one is the phone itself. That means
# Termux, a proot distro, and a 2.6 GB model pull — and on this device Termux
# cannot even be driven from a script (it does not request
# com.termux.permission.RUN_COMMAND, so `am broadcast` is silently dropped).
#
# There is a much cheaper route: run Ollama on the PC and let `adb reverse` make
# it appear on the PHONE's own loopback. Measured 2026-10-27 on the PZ261A:
#
#   adb reverse tcp:11434 tcp:11434
#   adb shell curl http://127.0.0.1:11434/v1/models   ->  HTTP 200
#
# The phone's app and `adb shell` share the initial network namespace (proven
# separately: the bridge on 127.0.0.1:8896 answers a request from the shell), so
# what works for the shell works for the app.
#
# WHY THIS IS THE RIGHT TRADE, stated plainly:
#   · no Ollama install on the phone, no Termux, no proot;
#   · the app sees 127.0.0.1, so AppConfigData.visionIsLocal is TRUE and the
#     background-sync privacy gate stays intact — no relaxation needed;
#   · the screenshot crosses USB to the user's own PC, never to a third party.
# What it costs: the tunnel needs USB. It dies when the cable comes out, and
# nothing on either side can rebuild it. That is why this script is idempotent
# and expected to be re-run, and why it says so instead of implying otherwise.
#
# What it does, in order:
#   1. locate adb and the device (single device is picked automatically)
#   2. check whether something answers on the PC's 127.0.0.1:11434
#   3. if not, say so and print the exact command — it does NOT install anything
#   4. establish the reverse tunnel
#   5. verify from the phone side, which is the only check that matters
#   6. print what to tap in the app's settings page
#
# Usage:
#   pwsh -File setup-phone-vision.ps1
#   pwsh -File setup-phone-vision.ps1 -Serial <adb serial>
#
# NOTE ON ErrorActionPreference. Same reason as provision-shell-sidecar.ps1:
# adb writes to stderr even on success, so 'Stop' would abort healthy runs.
# Failures are detected through $LASTEXITCODE and explicit probes.

[CmdletBinding()]
param(
    [string]$Serial = '',
    [int]$Port = 11434
)

$ErrorActionPreference = 'Continue'

# Windows PowerShell 5.1 writes to the console using the OEM codepage, so the
# Chinese strings below arrive as mojibake even when the file itself is read
# correctly. Setting the console's output encoding fixes it in Windows Terminal
# and through a redirected pipe alike. Wrapped in try/catch because there is no
# console at all when the output is captured rather than displayed.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

# ── locate everything relative to this script, never to the caller's cwd ────
# The repo is portable across drives; a hardcoded D:\ would break on a copy.
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$appDir = Split-Path -Parent $scriptDir

function Write-Step([string]$msg) { Write-Host "`n== $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg)   { Write-Host "  [ok] $msg" -ForegroundColor Green }
function Write-Warn([string]$msg) { Write-Host "  [!!] $msg" -ForegroundColor Yellow }
function Write-Bad([string]$msg)  { Write-Host "  [xx] $msg" -ForegroundColor Red }

# ── 1. find adb ─────────────────────────────────────────────────────────────
# Searched in this order: PATH, then the portable platform-tools that ships in
# this environment. Nothing here pins a drive letter.
$adb = $null
$cmd = Get-Command adb -ErrorAction SilentlyContinue
if ($cmd) {
    $adb = $cmd.Source
} else {
    $candidates = @()
    $candidates += (Join-Path $appDir '..\..\..\..\2-tools\Tools\platform-tools\adb.exe')
    $candidates += (Join-Path $appDir 'android\platform-tools\adb.exe')
    foreach ($c in $candidates) {
        if (Test-Path $c) { $adb = $c; break }
    }
}
if (-not $adb) {
    Write-Bad '找不到 adb。把它加进 PATH，或装 platform-tools。'
    exit 1
}
Write-Ok "adb: $adb"

# ── 2. pick the device ──────────────────────────────────────────────────────
# Parsed with a regex over the whole output rather than by splitting a line on a
# tab. The split version looks simpler and is not: `adb devices` pads its columns
# differently across versions, and `-split` treats its operand as a regex, so a
# pattern that reads as "a tab" can quietly match something else — the symptom is
# a serial like "a" and an error that says device 'a' not found, which points at
# adb rather than at the parsing.
if (-not $Serial) {
    $out = (& $adb devices 2>&1 | Out-String)
    $m = [regex]::Match($out, '(?m)^(\S+)\s+device\s*$')
    if (-not $m.Success) {
        Write-Bad '没有已连接的设备。插上 USB 并打开调试授权。'
        & $adb devices
        exit 1
    }
    $all = [regex]::Matches($out, '(?m)^(\S+)\s+device\s*$')
    if ($all.Count -gt 1) {
        Write-Warn "检测到 $($all.Count) 个设备，用第一个。多设备时请显式传 -Serial。"
    }
    $Serial = $m.Groups[1].Value
}
Write-Ok "device: $Serial"

# ── 3. is anything answering on the PC's 11434? ─────────────────────────────
# Probed BEFORE the tunnel so a failure here is not misreported as a tunnel
# failure. The two have different fixes and the difference is the whole point
# of checking separately.
Write-Step '检查 PC 上的 Ollama'
$pcOk = $false
try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/v1/models" -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
    if ($r.StatusCode -eq 200) {
        $pcOk = $true
        $models = ($r.Content | ConvertFrom-Json).data.id -join ', '
        Write-Ok "PC 端已在 $Port 应答。模型：$models"
    }
} catch {
    Write-Warn "PC 的 127.0.0.1:$Port 没有应答。"
}

if (-not $pcOk) {
    Write-Host @"

  Ollama 没有在 PC 上跑。这个脚本不替你装它——装什么、装哪份是你的决定。

  装好之后（Windows 官方安装包即可，不需要 Termux、不需要 proot）：
    1. 启动 Ollama（装完它会自己在后台跑；或用 `ollama serve`）
    2. ollama pull gelab-zero-4b
    3. 重跑本脚本

  注意：Ollama 默认只听 127.0.0.1。本脚本走的是 adb reverse，所以这样正好——
  它不会把你的模型端口暴露给局域网。

"@ -ForegroundColor Yellow
    exit 1
}

# ── 4. establish the reverse tunnel ─────────────────────────────────────────
Write-Step '建立 adb reverse 隧道'
$rev = & $adb -s $Serial reverse "tcp:$Port" "tcp:$Port" 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Bad "adb reverse 失败：$rev"
    exit 1
}
Write-Ok "tcp:$Port -> tcp:$Port"

# ── 5. verify FROM THE PHONE ────────────────────────────────────────────────
# The only check that matters. The PC answering proves nothing about whether the
# phone can reach it, and a tunnel that is up but not forwarding looks identical
# to a working one from this side.
Write-Step '从手机侧验证'
$phoneOk = $false
$probe = & $adb -s $Serial shell "curl -s -m 8 -o /dev/null -w '%{http_code}' http://127.0.0.1:$Port/v1/models" 2>&1
$probe = ($probe | Out-String).Trim()
if ($probe -match '200') {
    $phoneOk = $true
    Write-Ok "手机侧 127.0.0.1:$Port -> HTTP $probe"
} else {
    # Not every device ships curl. Fall back to a raw TCP connect, which needs
    # nothing but toybox.
    Write-Warn "curl 不可用或未通（返回 '$probe'），改用 TCP 连接探测"
    $tcp = & $adb -s $Serial shell "echo -n | timeout 5 toybox nc 127.0.0.1 $Port && echo OPEN" 2>&1
    $tcp = ($tcp | Out-String).Trim()
    if ($tcp -match 'OPEN') {
        $phoneOk = $true
        Write-Ok '手机侧 TCP 可连'
    } else {
        Write-Bad "手机侧连不上 127.0.0.1:$Port（返回 '$tcp'）"
    }
}

if (-not $phoneOk) {
    Write-Host @'

  隧道建了但手机侧不通。按可能性排序：
    1. adbd 需要重新授权——拔插 USB，看手机上的调试授权弹窗
    2. 设备是 Android 10+ 且 App 用了 VPN/独立网络栈——本机实测不是这种
    3. 换根线或换个 USB 口（TLS 调试对线材敏感）

'@ -ForegroundColor Yellow
    exit 1
}

# ── 6. what to do in the app ────────────────────────────────────────────────
Write-Step '手机上还要点三下'
Write-Host @"
  设置 -> 视觉模型：
    Base URL   http://localhost:$Port/v1
    模型名      gelab-zero-4b
    API Key     留空

  然后点「测试连接」，应该显示「就绪 · 本机推理，截图不出设备」。

  这三个值就是 App 的默认值，所以点一下「用本机 Ollama」再点「保存」也行。

  记住：USB 一拔，这条隧道就断，视觉定位会重新变成连不上。
  拔回来之后重跑本脚本即可，不用改 App 里的任何配置。
"@ -ForegroundColor White

Write-Host "`n完成。" -ForegroundColor Green
