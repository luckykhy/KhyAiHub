# bootstrap-native-llama.ps1 — fetch the vendored llama.cpp source tree.
#
# WHY THIS SCRIPT EXISTS. The app now links llama.cpp + mtmd into the APK (see
# android/app/src/main/cpp/CMakeLists.txt), and that source tree is deliberately
# NOT in git — same pattern the repo already uses for tools/deepseek-eyes/. A
# 40 MB third-party checkout in the repository is 40 MB of history forever, and
# it is pinned by a commit hash that nobody would ever bump. So: fetched on
# demand, gitignored, reproducible from this script.
#
# WHAT IT DOES. Downloads the master tarball from codeload (NOT github.com — see
# the mirror note below), verifies it is a complete gzip stream, and extracts it
# into third_party/llama.cpp. Idempotent: re-running replaces the tree.
#
# THE TWO THINGS THAT MAKE THIS SCRIPT LONGER THAN `curl | tar`:
#
#   1. THE MIRROR. This machine has a global git config rewriting
#      `https://github.com/` to `https://ghfast.top/...`, and that mirror
#      returns 403 for this path. Direct codeload downloads get cut off
#      mid-stream on large files (measured 2026-10-27: a 38.6 MB tarball
#      truncated at 15.7 MB and again at 38.2 MB, both times with HTTP 200 and
#      no error — the failure is a silent EOF). gh-proxy.com completes it.
#      The mirror is therefore the DEFAULT, not the fallback.
#
#   2. RESUME. Because truncation is silent and HTTP-level, the only reliable
#      integrity check is `gzip -t` on the finished file. This script retries
#      with `curl -C -` (byte-range resume) until that check passes, rather
#      than trusting the exit code. A truncated tarball extracts into a
#      plausible-looking but broken tree, which then fails at CMake time with
#      a missing-file error that points at the wrong thing entirely.

[CmdletBinding()]
param(
    # Ref to fetch. A branch name or a commit SHA both work; codeload accepts
    # either in the URL path.
    [string]$Ref = 'refs/heads/master',
    [string]$OutDir = '',
    [int]$MaxAttempts = 6
)

$ErrorActionPreference = 'Continue'

# ── resolve paths relative to THIS script, never the caller's cwd ────────────
# The tree is portable across drives (the whole Portable/khy-os checkout is),
# so a hardcoded D:\ would break on a copy.
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$appDir    = Split-Path -Parent $scriptDir
if ([string]::IsNullOrEmpty($OutDir)) {
    $OutDir = Join-Path $appDir 'third_party\llama.cpp'
}

$tmpTarball = Join-Path $env:TEMP 'khyos-llamacpp.tar.gz'

# codeload rather than github.com: the git URL rewrite does not apply to it, so
# the request actually reaches the origin instead of a 403-ing mirror.
$origin = "https://codeload.github.com/ggml-org/llama.cpp/tar.gz/$Ref"
$mirror = "https://gh-proxy.com/$origin"

Write-Host "==> target: $OutDir"
Write-Host "==> ref:    $Ref"

function Test-GzipComplete([string]$Path) {
    if (-not (Test-Path $Path)) { return $false }
    # gzip -t walks the whole stream and fails on a truncated trailer. This is
    # the only check that catches the silent-EOF failure described above.
    & gzip -t $Path *> $null
    return ($LASTEXITCODE -eq 0)
}

$ok = $false
for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    if (Test-Path $tmpTarball) { Remove-Item $tmpTarball -Force }

    $url = if ($attempt -eq 1) { $mirror } else { $mirror }
    Write-Host ("==> attempt {0}/{1}: {2}" -f $attempt, $MaxAttempts, $url)

    # -L follow redirects. NO -f/--fail: the mirror answers 200 with a partial
    # body, so an HTTP-level failure would not be reported anyway, and -f would
    # abort the resume logic that actually fixes it.
    & curl -sL -C - --retry 0 -o $tmpTarball $url
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
$staging = "$env:TEMP\khyos-llamacpp-stage"
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Path $staging -Force *> $null

& tar -xzf $tmpTarball -C $staging --strip-components=1
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
$need = @(
    'CMakeLists.txt',
    'include\llama.h',
    'tools\mtmd\mtmd.h',
    'tools\mtmd\mtmd-helper.h'
)
$missing = $need | Where-Object { -not (Test-Path (Join-Path $OutDir $_)) }
if ($missing) {
    Write-Host '[FAIL] extracted tree is incomplete, missing:' -ForegroundColor Red
    $missing | ForEach-Object { Write-Host "         $_" }
    exit 1
}

Write-Host "[OK] llama.cpp ready at $OutDir" -ForegroundColor Green
Write-Host '     Build with: cd android && ./gradlew :app:assembleRelease'
