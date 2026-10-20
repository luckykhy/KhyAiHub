@echo off
rem KhyOS Desktop launcher - self-locating, no window flash on double-click.
rem The shortcut's WorkingDirectory is this launcher folder, so this file
rem always runs from its own location regardless of where the .lnk was
rem copied. electron.exe is resolved 4 levels up from this folder:
rem   <root>\apps\khyos-desktop\launcher -> <root>
setlocal
set "APP_DIR=%~dp0"
for %%d in ("%APP_DIR%..") do set "APP_DIR=%%~fd"
rem launcher -> khyos-desktop -> apps -> khy-os (root): 3 levels up from APP_DIR
set "ROOT="
for %%d in ("%APP_DIR%..\..\..") do set "ROOT=%%~fd"
rem the electron app itself lives one level up (package.json + out/), not in launcher
for %%d in ("%APP_DIR%..") do set "APP_DIR=%%~fd"
rem electron.exe: pnpm virtual store first, then a plain node_modules
set "ELECTRON="
for /d %%p in ("%ROOT%\node_modules\.pnpm\electron@44.2.0") do if exist "%%~p\node_modules\electron\dist\electron.exe" set "ELECTRON=%%~p\node_modules\electron\dist\electron.exe"
if not defined ELECTRON (
    for /d %%p in ("%ROOT%\node_modules\.pnpm\electron@*") do if exist "%%~p\node_modules\electron\dist\electron.exe" set "ELECTRON=%%~p\node_modules\electron\dist\electron.exe"
)
if not defined ELECTRON (
    if exist "%ROOT%\node_modules\electron\dist\electron.exe" set "ELECTRON=%ROOT%\node_modules\electron\dist\electron.exe"
)
if not defined ELECTRON (
    echo [ERR] electron.exe not found under %ROOT% - repo moved? & pause & exit /b 1
)

rem --force: escape hatch for a hung instance. Without it a second click only
rem brings the running window forward; with it we do what this script used to
rem always do — kill every electron started from this app dir, then start clean.
rem It has to stay: a stuck main process never answers the second-instance
rem handoff, so the window would never come forward and the icon looks dead.
rem Kept as a jump target instead of an inline if(...) block on purpose — a
rem for /f with escaped pipes nested in parentheses is where cmd's parser lies.
if /i "%~1"=="--force" goto :force_restart

rem An instance launched from THIS app dir is already running: re-launching is
rem all that is needed. The new process fails requestSingleInstanceLock, hands
rem focus to the running window and exits (src/main/index.ts) — the user sees
rem the existing window come forward instead of a second one.
rem
rem The taskkill /F block that used to sit here is gone on purpose: it killed
rem the live session (in-flight AI turns, PTY terminals) and turned every second
rem double-click into a 3-second black-screen restart. It only ever existed to
rem dodge the GPU-cache lock, and the single-instance lock now prevents that at
rem the source. Hung-instance case is covered by --force below.
set "RUNNING="
for /f "usebackq tokens=*" %%p in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" ^| Where-Object { $_.CommandLine -like '*%APP_DIR%*' } ^| Select-Object -First 1 -ExpandProperty ProcessId" 2^>nul`) do set "RUNNING=%%p"
if defined RUNNING (
    pushd "%APP_DIR%"
    start "" "%ELECTRON%" . --disable-gpu --disable-software-rasterizer --in-process-gpu
    popd
    exit /b 0
)

:launch
if exist "%APP_DIR%\out\main\index.js" (
    pushd "%APP_DIR%"
    start "" "%ELECTRON%" . --disable-gpu --disable-software-rasterizer --in-process-gpu
    popd
) else (
    echo [i] out/ not built yet - launching dev mode ^(npm run dev^)
    pushd "%APP_DIR%"
    call npm run dev
    popd
)
endlocal
exit /b 0

:force_restart
for /f "usebackq tokens=*" %%p in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" ^| Where-Object { $_.CommandLine -like '*%APP_DIR%*' } ^| Select-Object -ExpandProperty ProcessId" 2^>nul`) do (
    taskkill /F /PID %%p >nul 2>&1
)
rem The GPU cache files are released asynchronously after the kill; without this
rem wait a fresh instance can hit ACCESS_DENIED on GPUCache - the exact reason
rem the old script waited here.
ping -n 4 127.0.0.1 >nul
goto :launch
