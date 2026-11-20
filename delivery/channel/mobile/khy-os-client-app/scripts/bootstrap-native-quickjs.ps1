# bootstrap-native-quickjs.ps1 — fetch the vendored quickjs-ng source tree.
#
# WHY THIS SCRIPT EXISTS. DESIGN-ARCH-195 (khyos 手机版插件架构选型) recommends
# option C — an in-process QuickJS plugin runtime — over option B (in-process JVM
# plugins). The decisive argument for C is that its attack surface is a small,
# auditable table of JNI bindings rather than arbitrary JVM bytecode running in
# the app's uid. That argument only holds if we OWN the bindings, which means we
# cannot take a prebuilt AAR that binds whatever its author chose: we compile the
# engine ourselves and write the shim.
#
# So this fetches the ENGINE ONLY — the C sources — and nothing else. There is no
# Kotlin/JNI layer here; that is written by hand in
# android/app/src/main/cpp/khy_js_jni.cpp, which is the file a reviewer reads to
# know what a plugin can touch.
#
# WHAT IT DOES. Downloads the quickjs-ng release tarball from codeload through the
# gh-proxy.com mirror, verifies it is a complete gzip stream, and extracts it into
# third_party/quickjs. Idempotent: re-running replaces the tree.
#
# WHY THE MIRROR IS THE DEFAULT, NOT THE FALLBACK. Measured on this machine
# (2026-10-27, fetching llama.cpp): direct codeload downloads get cut off
# mid-stream on large files — a 38.6 MB tarball truncated at 15.7 MB and again at
# 38.2 MB, both times with HTTP 200 and no error. The failure is a silent EOF, so
# the only reliable integrity check is `gzip -t` on the finished file. This script
# retries with `curl -C -` until that check passes rather than trusting the exit
# code. A truncated tarball extracts into a plausible-looking but broken tree,
# which then fails at CMake time with a missing-file error pointing at the wrong
# thing entirely.
#
# WHY quickjs-ng AND NOT bellard's quickjs. quickjs-ng is the maintained fork and
# is the engine the StepX platform itself embeds (verified 2026-10-29 by
# inspecting com.stepx.aiapp.pc242ff271564: libquickjs.so plus
# com.dokar.quickjs.* in its dex). Matching the engine that already runs on this
# device removes a whole class of "works on my build" risk.

[CmdletBinding()]
param(
    # Ref to fetch. A tag name or a commit SHA both work; codeload accepts either
    # in the URL path.
    [string]$Ref = 'refs/tags/v0.17.0',
    [string]$OutDir = '',
    [int]$MaxAttempts = 6
)

$ErrorActionPreference = 'Continue'

# ── resolve paths relative to THIS script, never the caller's cwd ────────────
# The tree is portable across drives (the whole Portable/khy-os checkout is), so
# a hardcoded D:\ would break on a copy. Same rule as every other script here.
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$appDir    = Split-Path -Parent $scriptDir
if ([string]::IsNullOrEmpty($OutDir)) {
    $OutDir = Join-Path $appDir 'third_party\quickjs'
}

$tmpTarball = Join-Path $env:TEMP 'khyos-quickjs.tar.gz'

# codeload rather than github.com: the git URL rewrite does not apply to it, so
# the request actually reaches the origin instead of a 403-ing mirror.
$origin = "https://codeload.github.com/quickjs-ng/quickjs/tar.gz/$Ref"
$mirror = "https://gh-proxy.com/$origin"

Write-Host "==> target: $OutDir"
Write-Host "==> ref:    $Ref"

function Test-GzipComplete([string]$Path) {
    if (-not (Test-Path $Path)) { return $false }
    # gzip -t walks the whole stream and fails on a truncated trailer. This is the
    # only check that catches the silent-EOF failure described above.
    & gzip -t $Path *> $null
    return ($LASTEXITCODE -eq 0)
}

$ok = $false
for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    if (Test-Path $tmpTarball) { Remove-Item $tmpTarball -Force }

    # -L follow redirects. NO -f/--fail: the mirror answers 200 with a partial
    # body, so an HTTP-level failure would not be reported anyway, and -f would
    # abort the resume logic that actually fixes it.
    #
    # curl.exe, NOT curl. In PowerShell `curl` is a built-in ALIAS for
    # Invoke-WebRequest (verified: Get-Command curl -> CommandType Alias), and
    # command resolution prefers aliases over external executables — so `& curl
    # -sL -C - -o ...` binds to Invoke-WebRequest, which rejects -s/-L/-C/-o with
    # AmbiguousParameter and downloads nothing. The failure is non-terminating, so
    # the script sails on and reports "downloaded 0.0 MB" before failing the gzip
    # check six attempts later, with an error message that never mentions curl.
    # Naming the .exe is the only way to reach the real binary.
    Write-Host ("==> attempt {0}/{1}: {2}" -f $attempt, $MaxAttempts, $mirror)
    & curl.exe -sL -C - --retry 0 -o $tmpTarball $mirror
    $sz = if (Test-Path $tmpTarball) { (Get-Item $tmpTarball).Length } else { 0 }
    Write-Host ("    downloaded {0:N1} MB" -f ($sz / 1MB))

    if (Test-GzipComplete $tmpTarball) {
        $ok = $true
        break
    }
    Write-Warning "    tarball is truncated; resuming"
    Start-Sleep -Seconds 2
}

if (-not $ok) {
    Write-Host '[FAIL] could not get a complete tarball after' $MaxAttempts 'attempts.' -ForegroundColor Red
    Write-Host '        Try a different ref (-Ref <sha>), or check the mirror.' -ForegroundColor Red
    exit 1
}

# ── extract ──────────────────────────────────────────────────────────────────
# Into a staging directory first, then swap. A half-extracted tree is worse than
# none: CMake would find a partial CMakeLists.txt and report a confusing error.
$staging = "$env:TEMP\khyos-quickjs-stage"
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Path $staging -Force *> $null

# The NATIVE Windows tar, not whatever `tar` resolves to. On this host the first
# `tar` on PATH is Git-for-Windows' MSYS tar, and MSYS parses a leading drive
# letter as an rsync-style remote host — `tar -xzf C:\Users\...\x.tar.gz` dies
# with "tar (child): Cannot connect to C: resolve failed", which names neither
# tar nor the path and reads like a network failure. bsdtar in System32 takes
# Windows paths natively. Reached through $env:SystemRoot so the script stays
# drive-letter independent (the whole checkout is portable).
$tarExe = Join-Path $env:SystemRoot 'System32\tar.exe'
if (-not (Test-Path -LiteralPath $tarExe)) {
    Write-Host '[FAIL] native tar not found at' $tarExe -ForegroundColor Red
    exit 1
}

& $tarExe -xzf $tmpTarball -C $staging --strip-components=1
if ($LASTEXITCODE -ne 0) {
    Write-Host '[FAIL] tar extraction failed.' -ForegroundColor Red
    exit 1
}

if (Test-Path $OutDir) { Remove-Item $OutDir -Recurse -Force }
New-Item -ItemType Directory -Path (Split-Path -Parent $OutDir) -Force *> $null
Move-Item $staging $OutDir

Remove-Item $tmpTarball -Force
Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue

# ── verify the tree is actually usable, not just present ─────────────────────
# These are the translation units the JNI shim compiles against. If upstream
# renames one, this check fails HERE — at bootstrap, with the filename — instead
# of at CMake time with an unresolved-symbol error that names nothing useful.
#
# Note what is NOT here: cutils.c. Upstream merged it into cutils.h in the -ng
# line, so a check list copied from bellard's quickjs (or from an older -ng tag)
# fails here on a perfectly good tree. dtoa.c is the other one people miss — it
# is a separate TU in -ng and the link fails without it.
$need = @(
    'quickjs.c',
    'quickjs.h',
    'cutils.h',
    'dtoa.c',
    'libregexp.c',
    'libunicode.c',
    'quickjs-libc.c',
    'quickjs-libc.h'
)
$missing = $need | Where-Object { -not (Test-Path (Join-Path $OutDir $_)) }
if ($missing) {
    Write-Host '[FAIL] extracted tree is incomplete, missing:' -ForegroundColor Red
    $missing | ForEach-Object { Write-Host "         $_" }
    exit 1
}

Write-Host "[OK] quickjs-ng ready at $OutDir" -ForegroundColor Green
Write-Host '     Build with: cd android && ./gradlew :app:assembleDebug'
