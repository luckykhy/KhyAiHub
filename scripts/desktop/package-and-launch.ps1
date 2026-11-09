# 桌面端「重打包 + 启动」一键脚本（Windows）
#
# 用途：把 apps/khyos-desktop 重新构建、打包，并在带 KHY_OS_DIR 的环境下启动打包版。
#
# 两个环境变量是有原因的，不是玄学：
#   · DESKTOP_UPDATE_URL —— package.json 的 build.publish.url 里写的是 ${env.DESKTOP_UPDATE_URL}，
#     不给值 electron-builder 会在配置展开阶段直接失败。
#   · KHY_OS_DIR —— host 进程靠它找后端（runtime/node/backend）；打包版没有仓库上下文，
#     不指回仓库根目录就会出现「会话列表加载失败」。
#
# 用法（仓库根目录）：
#   powershell -ExecutionPolicy Bypass -File scripts/desktop/package-and-launch.ps1

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$appDir = Join-Path $repo 'apps\khyos-desktop'
$cacheDir = Join-Path $repo 'works\data\khy\T4-transient\tmp\electron-cache'

# 工具一律从 PATH / 环境变量推导，不写死本机路径（守卫 no-hardcoded-abs-path）。
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
$npm = (Get-Command npm -ErrorAction SilentlyContinue).Source
if (-not $node -or -not $npm) { throw 'node / npm must be in PATH' }

# pnpm：electron-builder 用它收集 workspace 依赖；不在 PATH 时可用 KHY_PNPM_DIR 指定。
$pnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
if ($pnpmCmd) {
  $env:PATH = (Split-Path $pnpmCmd.Source -Parent) + ';' + $env:PATH
} elseif ($env:KHY_PNPM_DIR) {
  $env:PATH = $env:KHY_PNPM_DIR + ';' + $env:PATH
}

# 打包要 electron 运行时；默认走国内镜像（否则会卡在 GitHub 下载）。
$env:ELECTRON_MIRROR = 'https://registry.npmmirror.com/-/binary/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://registry.npmmirror.com/-/binary/electron-builder-binaries/'
$env:ELECTRON_CACHE = $cacheDir
# package.json 的 build.publish.url 写的是 ${env.DESKTOP_UPDATE_URL}，不给值配置展开就失败。
$env:DESKTOP_UPDATE_URL = 'https://updates.khy-os.invalid/releases'
New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null

Write-Output '=== 1/3 构建（electron-vite + host + scheduler） ==='
Push-Location $appDir
& $npm run build
if ($LASTEXITCODE -ne 0) { Pop-Location; throw 'build failed' }
Pop-Location

Write-Output '=== 2/3 打包（electron-builder） ==='
$cli = Join-Path $appDir 'node_modules\electron-builder\cli.js'
$log = Join-Path $repo 'works\data\khy\T4-transient\tmp\eb-final.log'
$errLog = Join-Path $repo 'works\data\khy\T4-transient\tmp\eb-final.err.log'
$args = @($cli, '--publish', 'never', "-c.electronDownload.cache=$cacheDir")
$proc = Start-Process -FilePath $node -ArgumentList $args -WorkingDirectory $appDir -RedirectStandardOutput $log -RedirectStandardError $errLog -PassThru -NoNewWindow
$proc.WaitForExit()
Get-Content $log -ErrorAction SilentlyContinue | Select-Object -Last 6
if ($proc.ExitCode -ne 0) {
  Get-Content $errLog -ErrorAction SilentlyContinue | Select-Object -Last 10
  throw "electron-builder failed (exit $($proc.ExitCode))"
}

Write-Output '=== 3/3 启动打包版 ==='
$exe = Join-Path $appDir 'dist-electron\win-unpacked\KhyOS Desktop.exe'
if (-not (Test-Path $exe)) { $exe = Join-Path $appDir 'dist-electron-pet\win-unpacked\KhyOS Desktop.exe' }
if (-not (Test-Path $exe)) { throw 'packaged exe not found' }
$env:KHY_OS_DIR = $repo
$app = Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe) -PassThru
Start-Sleep -Seconds 18
$alive = Get-Process -Id $app.Id -ErrorAction SilentlyContinue
if ($alive) {
  Write-Output ("launched pid=" + $app.Id + "  title='" + $alive.MainWindowTitle + "'")
} else {
  Write-Output 'process exited early'
}
Write-Output ("exe: " + $exe)
