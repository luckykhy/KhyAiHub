# Khy-OS Quick Setup Script
# Run this in PowerShell for instant configuration

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Khy-OS Global Command Setup" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check if profile exists
if (!(Test-Path -Path $PROFILE)) {
    Write-Host "[1/4] Creating PowerShell profile..." -ForegroundColor Yellow
    New-Item -ItemType File -Path $PROFILE -Force | Out-Null
    Write-Host "      Profile created: $PROFILE" -ForegroundColor Green
} else {
    Write-Host "[1/4] PowerShell profile exists" -ForegroundColor Green
}

# Check if khy already configured
$content = Get-Content $PROFILE -ErrorAction SilentlyContinue
if ($content -match 'khy-os|function khy') {
    Write-Host "[2/4] khy command already configured" -ForegroundColor Yellow
    $overwrite = Read-Host "      Overwrite? (y/n)"
    if ($overwrite -ne 'y') {
        Write-Host ""
        Write-Host "Setup cancelled. Use existing configuration." -ForegroundColor Yellow
        Write-Host ""
        exit
    }
}

# Add khy function
Write-Host "[2/4] Adding khy global command..." -ForegroundColor Yellow

# Resolve the entry point from this script's own location, so the generated
# profile points at wherever the user actually cloned khy-os. Hardcoding an
# absolute path here would leak one machine's layout to every user.
$khyEntry = Join-Path $PSScriptRoot 'runtime\node\backend\bin\khy.js'
if (!(Test-Path -Path $khyEntry)) {
    Write-Host "      ERROR: khy entry not found at $khyEntry" -ForegroundColor Red
    Write-Host "      Run this script from the khy-os repository root." -ForegroundColor Red
    exit 1
}

# The generated function used to be a bare `node <entry> $args`, which set none
# of the KHY_* environment contract. That forked the data home onto a second
# tree: `khy` from PowerShell saw ~/.khy while `khy` from khy.bat saw
# works\data\khy -- two caches, two session stores, one machine. The 16 vars
# below are the same contract khy-env.bat exports for the batch entries; keep
# the two in sync (khy-env.bat is the single source of truth for the .bat side).
# $PSScriptRoot is resolved now, at setup time, and baked into the profile --
# the profile is a per-machine artifact, so that is where the absolute path
# belongs.
$khyRepoRoot = $PSScriptRoot
$khyDataHome = Join-Path $khyRepoRoot 'works\data\khy'
$khyFunction = @"

# ========================================
# Khy-OS Global Command
# ========================================
# Env contract mirrors khy-os\khy-env.bat. Without it the data home forks onto
# ~/.khy and this entry stops sharing state with khy.bat / bin\khy.cmd.
function khy {
    `$env:KHYQUANT_PORTABLE_ROOT = "$khyRepoRoot"
    `$env:KHY_PORTABLE_ROOT = "$khyRepoRoot"
    `$env:KHY_OS_ROOT = "$khyRepoRoot"
    if (!`$env:KHY_DATA_HOME) { `$env:KHY_DATA_HOME = "$khyDataHome" }
    if (!`$env:KHY_PROJECT_DATA_HOME) { `$env:KHY_PROJECT_DATA_HOME = "$khyDataHome" }
    if (!`$env:KHYQUANT_DATA_HOME) { `$env:KHYQUANT_DATA_HOME = `$env:KHY_DATA_HOME }
    `$env:KHYOS_HOME = "$khyRepoRoot\works\data\khyos"
    `$env:KHY_COORDINATOR_MODE = "true"
    `$env:KHY_RUNTIME_HOME = "`$env:KHY_DATA_HOME\runtime"
    `$env:KHY_CACHE_HOME = "`$env:KHY_DATA_HOME\cache"
    `$env:KHY_LOG_HOME = "`$env:KHY_DATA_HOME\logs"
    `$env:KHY_TEMP_HOME = "`$env:KHY_DATA_HOME\tmp"
    `$env:KHY_PLATFORM_PATH = "$khyRepoRoot\runtime\substrate\platform"
    `$env:KHY_INVOKED_AS = "khy"
    `$env:KHYQUANT_ROOT = "$khyRepoRoot\runtime\node\backend"
    `$env:KHYQUANT_INVOKED_AS = "khy"
    node "$khyEntry" `$args
}
"@

Add-Content -Path $PROFILE -Value $khyFunction
Write-Host "      khy function added" -ForegroundColor Green

# Reload profile
Write-Host "[3/4] Reloading configuration..." -ForegroundColor Yellow
. $PROFILE
Write-Host "      Configuration reloaded" -ForegroundColor Green

# Enable transparent NTFS compression (Windows, best-effort, never fails setup)
Write-Host "[4/4] Enabling NTFS transparent compression..." -ForegroundColor Yellow
$compressScript = Join-Path $PSScriptRoot 'scripts\install\enable-ntfs-compression.ps1'
if (Test-Path -Path $compressScript) {
    & $compressScript -ProjectRoot $PSScriptRoot
} else {
    Write-Host "      Compression helper not found, skipped (files stay uncompressed)" -ForegroundColor DarkGray
}

# Test
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Setup Complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "Testing..." -ForegroundColor Yellow
try {
    $version = khy --version 2>&1
    Write-Host "khy version: $version" -ForegroundColor Green
    Write-Host ""
    Write-Host "Success! You can now use 'khy' command anywhere!" -ForegroundColor Green
} catch {
    Write-Host "Please restart PowerShell and try: khy --version" -ForegroundColor Yellow
}
Write-Host ""
