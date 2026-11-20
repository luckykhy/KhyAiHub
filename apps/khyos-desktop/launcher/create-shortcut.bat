@echo off
chcp 65001 >nul
setlocal

set "APP_DIR=%~dp0"
set "DESKTOP=%USERPROFILE%\Desktop"
set "SHORTCUT_PATH=%DESKTOP%\KhyOS Desktop.lnk"
set "DEV_SHORTCUT_PATH=%DESKTOP%\KhyOS Desktop (开发用).lnk"

echo ========================================
echo   创建 KhyOS Desktop 桌面快捷方式
echo ========================================
echo.
echo 应用目录: %APP_DIR%
echo.

rem Two shortcuts, because the two launch modes are genuinely different things:
rem   "KhyOS Desktop"            -> the built app (entries/electron/dist-electron), what a user wants
rem   "KhyOS Desktop (开发用)"    -> npm run dev, what a maintainer wants
rem The single shortcut this script used to create pointed at `npm run dev`, so a
rem double-click started a Vite dev server (with its own console window and a
rem cold compile) instead of the already-built packaged app under entries/electron/.

rem 构建产物唯一根是仓库根的 entries/（LAYOUT-005），打包输出 2026-11-19 从
rem dist-electron/ 迁到 entries/electron/dist-electron/（check-build-root 登记目标）。
set "DIST_EXE=%APP_DIR%..\..\entries\electron\dist-electron\win-unpacked\KhyOS Desktop.exe"
if not exist "%DIST_EXE%" (
    echo [WARN] 未找到构建产物: %DIST_EXE%
    echo        请先运行 npm run electron:build，或使用「开发用」快捷方式。
    echo.
)

powershell -ExecutionPolicy Bypass -Command "$ws = New-Object -ComObject WScript.Shell; $sc = $ws.CreateShortcut('%SHORTCUT_PATH%'); $sc.TargetPath = '%DIST_EXE%'; $sc.WorkingDirectory = '%APP_DIR%'; $sc.WindowStyle = 7; $sc.Description = 'KhyOS Desktop'; $sc.Save(); Write-Host 'main OK'"

powershell -ExecutionPolicy Bypass -Command "$ws = New-Object -ComObject WScript.Shell; $sc = $ws.CreateShortcut('%DEV_SHORTCUT_PATH%'); $sc.TargetPath = 'cmd.exe'; $sc.Arguments = '/c \"cd /d \"%APP_DIR%\" && npm run dev\"'; $sc.WorkingDirectory = '%APP_DIR%'; $sc.WindowStyle = 7; $sc.Description = 'KhyOS Desktop (dev)'; $sc.Save(); Write-Host 'dev OK'"

if exist "%SHORTCUT_PATH%" (
    echo [OK] 已创建: %SHORTCUT_PATH%
) else (
    echo [FAIL] 主快捷方式创建失败，请手动创建
)
if exist "%DEV_SHORTCUT_PATH%" (
    echo [OK] 已创建: %DEV_SHORTCUT_PATH%
) else (
    echo [FAIL] 开发用快捷方式创建失败，请手动创建
)

echo.
echo 双击桌面的 "KhyOS Desktop" 即可启动；开发调试用 "(开发用)" 那个。
pause
