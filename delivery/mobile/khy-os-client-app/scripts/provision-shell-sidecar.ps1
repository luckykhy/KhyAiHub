# provision-shell-sidecar.ps1 — one command to arm the phone's elevated exec.
#
# WHY this script exists. An app-uid process cannot grant itself shell
# privilege; something that already holds shell authority has to start the
# elevated process. `adb shell` is that authority, and it runs a class that
# ships INSIDE the khy-os APK — so the phone keeps exactly one APK, with no
# Shizuku install and no second app to authorize.
#
# What it does, in order:
#   1. locate the release APK built by gradle
#   2. pull classes.dex out of it (3 MB, not the 77 MB APK)
#   3. push it to /data/local/tmp
#   4. kill any sidecar left over from a previous run
#   5. start it as uid 2000 via `dalvikvm`, detached with setsid
#   6. restore the accessibility service, which a fresh install always clears
#   7. wait for the sidecar's own "listening" line and report
#
# Idempotent: safe to re-run. It is EXPECTED to be re-run after every phone
# reboot — nothing on the device can restart a uid-2000 process without root,
# device-owner provisioning, or a Shizuku-style self-pairing flow. That limit
# is real and the overlay says so rather than pretending otherwise.
#
# Usage:
#   pwsh -File provision-shell-sidecar.ps1
#   pwsh -File provision-shell-sidecar.ps1 -Serial <adb serial>
#
# NOTE ON ErrorActionPreference. It is deliberately 'Continue', not 'Stop'.
# `& adb ... 2>&1` turns anything adb writes to stderr into an ErrorRecord, and
# adb writes to stderr even on success; under 'Stop' that aborts the script on
# a healthy run. Failures are therefore detected explicitly through
# $LASTEXITCODE and the sidecar's own log, never through the error stream.

[CmdletBinding()]
param(
    [string]$Serial = '',
    [int]$Port = 8897
)

$ErrorActionPreference = 'Continue'

# ── locate everything relative to this script, never to the caller's cwd ────
# The repo is portable across drives; a hardcoded D:\ would break on a copy.
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$appDir = Split-Path -Parent $scriptDir
$androidDir = Join-Path $appDir 'android'
$apkCandidates = @(
    Join-Path $androidDir 'app\build\outputs\apk\release\app-release.apk'
    Join-Path $appDir 'build\app\outputs\apk\release\app-release.apk'
)
$apk = $apkCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $apk) {
    Write-Host '[FAIL] release APK not found. Build it first:' -ForegroundColor Red
    Write-Host '         cd <repo>\delivery\mobile\khy-os-client-app\android'
    Write-Host '         .\gradlew :app:assembleRelease'
    exit 1
}

$sidecarClass = 'com.khyos.khy_os_client.shell.ShellSidecar'
$pkg = 'com.khyos.khy_os_client'
$remoteDex = '/data/local/tmp/khyos.dex'
$remoteLog = '/data/local/tmp/sidecar.log'

function Resolve-Adb {
    # Portable rule: never assume a drive letter. ANDROID_HOME first, then PATH.
    $sdk = $env:ANDROID_HOME
    if (-not $sdk) { $sdk = $env:ANDROID_SDK_ROOT }
    if ($sdk) {
        $candidate = Join-Path $sdk 'platform-tools\adb.exe'
        if (Test-Path $candidate) { return $candidate }
    }
    $onPath = Get-Command adb -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    throw 'adb not found. Set ANDROID_HOME or put platform-tools on PATH.'
}

$adb = Resolve-Adb
& $adb start-server *> $null

# ── pick exactly one device, never guess ────────────────────────────────────
# A stale wireless-debugging entry lingers in `adb devices` for a long time, so
# more than one row is the normal case here. Picking one silently would arm the
# wrong phone; refusing and listing them is the only honest option.
$raw = & $adb devices 2>&1 | Out-String
$rows = @()
foreach ($line in ($raw -split "`r?`n")) {
    # The serial is NOT \S+: a wireless-debugging TLS transport shows up as
    # e.g. "adb-ZYPZ261A01M6870010L-R9QdlL (2)._adb-tls-connect._tcp", with
    # spaces and parentheses in it. Matching \S+ silently drops exactly the
    # device we care about, which then looks like "no device attached".
    if ($line -match '^(.+?)\s+device\s*$') { $rows += $Matches[1].Trim() }
}
if ($rows.Count -eq 0) {
    Write-Host '[FAIL] no adb device in the "device" state. Wireless debugging' -ForegroundColor Red
    Write-Host '       must be enabled and paired on the phone.' -ForegroundColor Red
    exit 1
}
if ($rows.Count -gt 1 -and -not $Serial) {
    Write-Host '[FAIL] more than one device is attached. Refusing to guess.' -ForegroundColor Red
    Write-Host '       Re-run with -Serial <one of these>:' -ForegroundColor Red
    foreach ($r in $rows) { Write-Host "         $r" }
    exit 1
}
if ($Serial) {
    if ($rows -notcontains $Serial) {
        Write-Host "[FAIL] -Serial $Serial is not in the device list:" -ForegroundColor Red
        foreach ($r in $rows) { Write-Host "         $r" }
        exit 1
    }
    $target = $Serial
} else {
    $target = $rows[0]
}
$serialArgs = @('-s', $target)

function Invoke-AdbShell {
    param([string]$Command)
    $out = & $adb @serialArgs shell $Command 2>&1 | Out-String
    return $out
}

Write-Host "[1/7] APK        : $apk"
Write-Host "[2/7] device     : $target"

# ── 3. extract classes.dex ──────────────────────────────────────────────────
$tmpDir = Join-Path $env:TEMP 'khyos-sidecar'
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
$dexPath = Join-Path $tmpDir 'classes.dex'

try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($apk)
    try {
        $entry = $zip.GetEntry('classes.dex')
        if (-not $entry) { throw 'classes.dex not found in the APK' }
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $dexPath, $true)
    } finally {
        $zip.Dispose()
    }
} catch {
    Write-Host "[FAIL] could not read classes.dex: $_" -ForegroundColor Red
    exit 1
}
$dexSize = (Get-Item $dexPath).Length
Write-Host "[3/7] classes.dex: $dexSize bytes"

# ── 4. push ─────────────────────────────────────────────────────────────────
$pushOut = & $adb @serialArgs push $dexPath $remoteDex 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
    Write-Host "[FAIL] push failed: $pushOut" -ForegroundColor Red
    exit 1
}
Write-Host "[4/7] pushed to  : $remoteDex"

# ── 5. restart the sidecar ──────────────────────────────────────────────────
# Kill by class name first: a stale sidecar still holds the port and the new
# one would silently fail to bind, which reads as "provisioning worked" until
# the first exec times out.
Invoke-AdbShell "pkill -f $sidecarClass" | Out-Null
Start-Sleep -Milliseconds 800
Invoke-AdbShell "rm -f $remoteLog" | Out-Null

$startCmd = "setsid dalvikvm -cp $remoteDex $sidecarClass --port $Port > $remoteLog 2>&1 < /dev/null &"
Invoke-AdbShell $startCmd | Out-Null

# ── 6. accessibility + bridge revival, which a fresh install always clears ──
# A fresh install drops BOTH the accessibility service and every started
# service. Restoring only the first leaves the bridge down, which then looks
# exactly like "the sidecar did not work". The REVIVE broadcast is idempotent,
# so sending it unconditionally is correct in every state.
$svc = "$pkg/$pkg.KhyAccessibilityService"
Invoke-AdbShell "settings put secure enabled_accessibility_services $svc" | Out-Null
Invoke-AdbShell 'settings put secure accessibility_enabled 1' | Out-Null
Invoke-AdbShell "am broadcast -a $pkg.bridge.REVIVE -n $pkg/$pkg.bridge.ReviveReceiver" | Out-Null
Start-Sleep -Seconds 3

# ── 7. verify from the sidecar's own log ────────────────────────────────────
$ok = $false
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    $log = Invoke-AdbShell "cat $remoteLog 2>/dev/null"
    if ($log -match 'listening 127\.0\.0\.1:(\d+) as uid (\d+)') {
        Write-Host "[7/7] sidecar    : listening on $($Matches[1]) as uid $($Matches[2])" -ForegroundColor Green
        $ok = $true
        break
    }
    if ($log -match 'ClassNotFoundException|NoSuchMethod|Error|Exception') {
        Write-Host '[FAIL] sidecar did not start. Log:' -ForegroundColor Red
        Write-Host $log
        Write-Host ''
        Write-Host '  Most likely cause: R8 renamed or stripped the sidecar class.' -ForegroundColor Yellow
        Write-Host '  Check android/app/proguard-rules.pro still keeps it.' -ForegroundColor Yellow
        exit 1
    }
}

if (-not $ok) {
    Write-Host '[FAIL] sidecar never printed its listening line. Log:' -ForegroundColor Red
    Write-Host (Invoke-AdbShell "cat $remoteLog 2>/dev/null")
    exit 1
}

# Confirm the adb channel really is uid 2000 — a sidecar that started but
# degraded would otherwise look identical from here.
$uid = (Invoke-AdbShell 'id -u').Trim()
if ($uid -ne '2000') {
    Write-Host "[WARN] adb shell reports uid $uid, expected 2000. The sidecar may" -ForegroundColor Yellow
    Write-Host '       not have the privilege this is meant to grant.' -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'Done. exec now prefers the sidecar, then Shizuku, then the app uid.' -ForegroundColor Green
Write-Host 'The `info` bridge tool reports sidecar / sidecar_why / shizuku / shizuku_why.' -ForegroundColor Green
Write-Host ''
Write-Host 'REMINDER: this does not survive a reboot. Re-run this script then.' -ForegroundColor Cyan
