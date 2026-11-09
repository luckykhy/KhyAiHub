@echo off
chcp 65001 >nul
rem 双击这个：盯着 src/ 的改动，改完自动重建 out/ 并重启窗口。
rem 关掉这个黑窗口只停止监听，应用本身继续跑最后一次构建的产物。
setlocal
set "APP_DIR=%~dp0"
for %%d in ("%APP_DIR%..") do set "APP_DIR=%%~fd"

rem 两个监听同时跑会互相踩 out/（一个在写、一个在清），所以第二个直接不进。
set "WATCHING="
for /f "usebackq tokens=*" %%p in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" ^| Where-Object { $_.CommandLine -like '*watch-rebuild.cjs*' } ^| Select-Object -First 1 -ExpandProperty ProcessId" 2^>nul`) do set "WATCHING=%%p"
if defined WATCHING (
    echo [i] 已经在监听中 ^(pid %WATCHING%^)，不重复开。
    timeout /t 3 >nul
    exit /b 0
)

where node >nul 2>nul
if errorlevel 1 (
    echo [ERR] 找不到 node —— 构建脚本要它。检查 PATH 里有没有 node。
    pause
    exit /b 1
)

pushd "%APP_DIR%"
node scripts\watch-rebuild.cjs --relaunch
popd
echo.
echo 监听已退出。应用若还开着，跑的是最后一次构建的产物。
pause
endlocal
