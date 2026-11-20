# provision-shell-sidecar.ps1 — one command to arm the phone's elevated exec.
#
# WHY this script exists. An app-uid process cannot grant itself shell
# privilege; something that already holds shell authority has to start the
# elevated process. `adb shell` is that authority, and it runs a class that
# ships INSIDE the khy-os APK — so the phone keeps exactly one APK, with no
# second app to install and no extra app to authorize.
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
# device-owner provisioning, or a self-pairing flow. That limit
# is real and the overlay says so rather than pretending otherwise.
#
# Usage:
#   pwsh -File provision-shell-sidecar.ps1
#   pwsh -File provision-shell-sidecar.ps1 -Serial <adb serial>
#   pwsh -File provision-shell-sidecar.ps1 -FromDevice
#
# WHERE THE classes.dex COMES FROM. The sidecar class has to match the app
# that is actually running on the phone, so the honest default is the APK
# that is installed there:
#   -FromDevice  pull the installed APK over adb and take classes.dex from
#                it. Works with no local build at all.
#   -ApkPath     an explicit APK on this PC.
#   (default)    the gradle release output in this repo, if it exists.
#
# WIRELESS DEBUGGING (no cable). The phone shows two different things and
# they are easy to mix up:
#   · "Use pairing code to pair a device" -> an ip:port AND a 6-digit code.
#     That pair is for -PairAddress / -PairCode.
#   · the wireless debugging screen itself -> an ip:port with a DIFFERENT
#     port. That is the connect endpoint. Leave -ConnectAddress out and the
#     script finds it over mDNS; pass it if your network blocks mDNS.
#   pwsh -File provision-shell-sidecar.ps1 -PairAddress 192.168.1.23:37129 -PairCode 123456
#
# NOTE ON ErrorActionPreference. It is deliberately 'Continue', not 'Stop'.
# `& adb ... 2>&1` turns anything adb writes to stderr into an ErrorRecord, and
# adb writes to stderr even on success; under 'Stop' that aborts the script on
# a healthy run. Failures are therefore detected explicitly through
# $LASTEXITCODE and the sidecar's own log, never through the error stream.

[CmdletBinding()]
param(
    [string]$Serial = '',
    [int]$Port = 8897,
    [string]$PairAddress = '',
    [string]$PairCode = '',
    [string]$ConnectAddress = '',
    [string]$ApkPath = '',
    [string]$PubKey = '',
    [switch]$FromDevice
)

$ErrorActionPreference = 'Continue'

# ── locate everything relative to this script, never to the caller's cwd ────
# The repo is portable across drives; a hardcoded D:\ would break on a copy.
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
# Shared device addressing + wireless pairing rules. One copy, so that every
# script that sources it can never disagree about which phone
# is "the" phone.
. (Join-Path $scriptDir 'adb-wireless.ps1')
$appDir = Split-Path -Parent $scriptDir
$androidDir = Join-Path $appDir 'android'

$sidecarClass = 'com.khyos.khy_os_client.shell.ShellSidecar'
$pkg = 'com.khyos.khy_os_client'
$remoteDex = '/data/local/tmp/khyos.dex'
$remoteLog = '/data/local/tmp/sidecar.log'
$remotePid = '/data/local/tmp/sidecar.pid'

try {
    $target_env = Invoke-AdbWirelessSetup -Serial $Serial -PairAddress $PairAddress `
        -PairCode $PairCode -ConnectAddress $ConnectAddress
} catch {
    Write-Host "[FAIL] $_" -ForegroundColor Red
    exit 1
}
$adb = $target_env.Adb
$target = $target_env.Serial
$serialArgs = $target_env.SerialArgs

# NOTE: `Invoke-AdbShell` comes from adb-wireless.ps1 — one way to run a
# command on the phone, shared across the scripts that source it.

# ── 1. locate the APK to take classes.dex from ─────────────────────────────
# Three sources, in order of explicitness:
#   -ApkPath     an explicit path (a build output, or any APK on this PC)
#   -FromDevice  the APK that is INSTALLED on the phone, pulled over adb.
#                This is the one that matters when there is no local build:
#                the sidecar class has to match the app that is actually
#                running, and the installed APK is the ground truth for that.
#   (default)    the gradle release output in this repo
$tmpDir = Join-Path $env:TEMP 'khyos-sidecar'
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null

$apk = ''
if ($ApkPath) {
    if (-not (Test-Path $ApkPath)) {
        Write-Host "[FAIL] -ApkPath does not exist: $ApkPath" -ForegroundColor Red
        exit 1
    }
    $apk = (Resolve-Path $ApkPath).Path
} elseif ($FromDevice) {
    $pmOut = Invoke-AdbShell -Adb $adb -SerialArgs $serialArgs -Command "pm path $pkg"
    $remoteApk = ''
    foreach ($line in ($pmOut -split "`r?`n")) {
        $t = $line.Trim()
        if ($t.StartsWith('package:')) { $remoteApk = $t.Substring('package:'.Length).Trim(); break }
    }
    if (-not $remoteApk) {
        Write-Host "[FAIL] $pkg is not installed on $target." -ForegroundColor Red
        exit 1
    }
    $apk = Join-Path $tmpDir 'khyos-installed.apk'
    Write-Host "[1/7] device     : $target"
    Write-Host "[2/7] APK        : pulling the installed app from the phone ($remoteApk)"
    $pullOut = & $adb @serialArgs pull $remoteApk $apk 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[FAIL] pull failed: $pullOut" -ForegroundColor Red
        exit 1
    }
} else {
    $apkCandidates = @(
        Join-Path $androidDir 'app\build\outputs\apk\release\app-release.apk'
        Join-Path $appDir 'build\app\outputs\apk\release\app-release.apk'
    )
    $apk = $apkCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $apk) {
        Write-Host '[FAIL] release APK not found. Build it first:' -ForegroundColor Red
        Write-Host '         cd <repo>\delivery\channel\mobile\khy-os-client-app\android' -ForegroundColor Red
        Write-Host '         .\gradlew :app:assembleRelease' -ForegroundColor Red
        Write-Host '       Or skip the local build: -FromDevice pulls the installed APK.' -ForegroundColor Yellow
        exit 1
    }
}

Write-Host "[1/7] device     : $target"
Write-Host "[2/7] APK        : $apk"

# ── 3. extract classes.dex ──────────────────────────────────────────────────
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
# Kill by pidfile, never by class name: `pkill -f <class>` also matches the
# shell running the launch line (the class name is in that line), so the kill
# lands on the wrong process and the sidecar is never actually replaced.
Invoke-AdbShell -Adb $adb -SerialArgs $serialArgs -Command "kill `$(cat $remotePid 2>/dev/null) 2>/dev/null; rm -f $remotePid" | Out-Null
Start-Sleep -Milliseconds 800
Invoke-AdbShell -Adb $adb -SerialArgs $serialArgs -Command "rm -f $remoteLog" | Out-Null

# The sidecar authenticates its caller by challenge-response against the app's
# device public key. (It used to read a shared token from /sdcard; the bridge
# stopped writing that file, so without the key the sidecar denies every
# request while still looking alive.) The key is a PUBLIC key — the secret half
# never leaves the app's private directory — so handing it over costs nothing.
#
# Where to get it: `elevate op=status` on the bridge reports it as
# device_pub_b64 (any paired PC can call that), or GET /status with the paired
# certificate. It is deliberately NOT fetched here: doing so would mean this
# script signing a proof-of-possession request, and a second copy of that
# signing logic is how the two drift.
$pub = $env:KHY_SIDECAR_PUB
if (-not $pub -and $PubKey) { $pub = $PubKey }
if (-not $pub) {
    Write-Host '[FAIL] no device public key: the sidecar would deny every request.' -ForegroundColor Red
    Write-Host '       Get it from the paired PC:  node bridge.mjs call elevate {"op":"status"}' -ForegroundColor Red
    Write-Host '       then:  -PubKey <device_pub_b64>   (or set KHY_SIDECAR_PUB)' -ForegroundColor Red
    exit 1
}

$startCmd = "setsid dalvikvm -cp $remoteDex $sidecarClass --port $Port --pub '$pub' > $remoteLog 2>&1 < /dev/null & echo `$! > $remotePid"
Invoke-AdbShell -Adb $adb -SerialArgs $serialArgs -Command $startCmd | Out-Null

# ── 6. accessibility + bridge revival, which a fresh install always clears ──
# A fresh install drops BOTH the accessibility service and every started
# service. Restoring only the first leaves the bridge down, which then looks
# exactly like "the sidecar did not work". The REVIVE broadcast is idempotent,
# so sending it unconditionally is correct in every state.
$svc = "$pkg/$pkg.KhyAccessibilityService"
Invoke-AdbShell -Adb $adb -SerialArgs $serialArgs -Command "settings put secure enabled_accessibility_services $svc" | Out-Null
Invoke-AdbShell -Adb $adb -SerialArgs $serialArgs -Command 'settings put secure accessibility_enabled 1' | Out-Null
Invoke-AdbShell -Adb $adb -SerialArgs $serialArgs -Command "am broadcast -a $pkg.bridge.REVIVE -n $pkg/$pkg.bridge.ReviveReceiver" | Out-Null
Start-Sleep -Seconds 3

# ── 7. verify from the sidecar's own log ────────────────────────────────────
$ok = $false
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    $log = Invoke-AdbShell -Adb $adb -SerialArgs $serialArgs -Command "cat $remoteLog 2>/dev/null"
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
    Write-Host (Invoke-AdbShell -Adb $adb -SerialArgs $serialArgs -Command "cat $remoteLog 2>/dev/null")
    exit 1
}

# Confirm the adb channel really is uid 2000 — a sidecar that started but
# degraded would otherwise look identical from here.
$uid = (Invoke-AdbShell -Adb $adb -SerialArgs $serialArgs -Command 'id -u').Trim()
if ($uid -ne '2000') {
    Write-Host "[WARN] adb shell reports uid $uid, expected 2000. The sidecar may" -ForegroundColor Yellow
    Write-Host '       not have the privilege this is meant to grant.' -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'Done. exec runs as uid 2000 while the sidecar answers, else as the app uid.' -ForegroundColor Green
Write-Host 'The `info` bridge tool reports elevated / sidecar / sidecar_why / elevation_why.' -ForegroundColor Green
Write-Host ''
Write-Host 'REMINDER: this does not survive a reboot. Re-run this script then.' -ForegroundColor Cyan
