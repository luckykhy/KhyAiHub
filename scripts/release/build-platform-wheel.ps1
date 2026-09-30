# @pattern Command, Template Method
Param(
  [switch]$UsePyPABuild
)

$ErrorActionPreference = 'Stop'
$Root = Resolve-Path (Join-Path $PSScriptRoot '..' '..')
Set-Location $Root

function Resolve-PythonCommand {
  if (Get-Command py -ErrorAction SilentlyContinue) {
    return @{ Cmd = 'py'; Args = @('-3') }
  }
  if (Get-Command python -ErrorAction SilentlyContinue) {
    return @{ Cmd = 'python'; Args = @() }
  }
  throw 'Missing python launcher: expected `py` or `python` in PATH.'
}

$Py = Resolve-PythonCommand

# [LAYOUT-005] 产物单一根：entries/pip（BUILD-OUTPUTS.json 已登记，方案 R-R2 迁入）。
$DistDir = Join-Path $Root 'entries\pip'

function Remove-BuildResidue {
  if (Test-Path $DistDir) { Remove-Item $DistDir -Recurse -Force }
  if (Test-Path build) { Remove-Item build -Recurse -Force }
  if (Test-Path khy_os.egg-info) { Remove-Item khy_os.egg-info -Recurse -Force }
}

function Move-SetuptoolsResidue {
  # setuptools 的 build/ 与 egg-info 无视 cwd 写在项目根，搬进登记位。
  foreach ($pair in @(@('build', 'build'), @('khy_os.egg-info', 'egg-info'))) {
    $src = Join-Path $Root $pair[0]
    if (-not (Test-Path $src)) { continue }
    $dst = Join-Path $DistDir $pair[1]
    if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
    New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
    Move-Item $src $dst
  }
}

Remove-BuildResidue

# Default path is offline-friendly and avoids isolated build env dependency resolution.
& $Py.Cmd @($Py.Args + @('setup.py', 'sdist', '--dist-dir', $DistDir, 'bdist_wheel', '--dist-dir', $DistDir))
Move-SetuptoolsResidue

if ($UsePyPABuild) {
  Remove-BuildResidue
  & $Py.Cmd @($Py.Args + @('-m', 'build', '--no-isolation', '--sdist', '--wheel', '--outdir', $DistDir))
  Move-SetuptoolsResidue
}

Write-Host "`nBuilt artifacts:" -ForegroundColor Cyan
Get-ChildItem $DistDir | Select-Object Name, Length, LastWriteTime
