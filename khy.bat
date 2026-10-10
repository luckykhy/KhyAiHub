@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

:: =============================================================================
:: khy.bat - Windows launcher for Khy-OS CLI
:: =============================================================================

:: --- Proxy env vars: preserved (required for China network: agnes blocked without proxy) ---
:: set "HTTP_PROXY="
:: set "HTTPS_PROXY="
:: set "http_proxy="
:: set "https_proxy="

:: --- khy repair: one-shot portable self-repair (Node only, bypasses python cli) ---
if /i "%~1"=="repair" (
    where node >nul 2>&1
    if !ERRORLEVEL! neq 0 call :discover_node
    if defined NODE_FOUND_DIR set "PATH=!NODE_FOUND_DIR!;!PATH!"
    where node >nul 2>&1
    if !ERRORLEVEL! neq 0 (
        echo [ERROR] khy repair needs Node.js 20+ in PATH: https://nodejs.org/
        exit /b 1
    )
    set "KHYQUANT_PORTABLE_ROOT=%~dp0"
    node "%~dp0delivery\extension\scripts\khy-portable\repair-portable.js" %2 %3 %4 %5 %6 %7 %8 %9
    exit /b !ERRORLEVEL!
)

:: --- Detect Python 3.8+ ---
set "PYTHON_CMD="

:: Probe every absolute path `where` returns, not just the first name: the
:: WindowsApps store-alias stub (python.exe present, exits 9009, no stdout)
:: shadows a real install later in PATH, so each candidate must be probed.
for %%P in (python3 python) do (
    if not defined PYTHON_CMD (
        for /f "delims=" %%I in ('where %%P 2^>nul') do (
            if not defined PYTHON_CMD call :try_python "%%~fI"
        )
    )
)

if not defined PYTHON_CMD (
    where py >nul 2>&1
    if !ERRORLEVEL! equ 0 (
        for /f "tokens=*" %%V in ('py -3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2^>nul') do (
            for /f "tokens=1,2 delims=." %%A in ("%%V") do (
                if %%A geq 3 (
                    if %%A equ 3 (
                        if %%B geq 8 set "PYTHON_CMD=py -3"
                    ) else (
                        set "PYTHON_CMD=py -3"
                    )
                )
            )
        )
    )
)

if not defined PYTHON_CMD (
    for %%F in (
        "%~dp0runtime\python\python.exe"
        "%~dp0.khy\python\python.exe"
    ) do (
        if not defined PYTHON_CMD call :try_python "%%~fF"
    )
)

if not defined PYTHON_CMD if defined LOCALAPPDATA if exist "%LOCALAPPDATA%\Programs\Python" (
    for /f "delims=" %%D in ('dir /b /ad /o-n "%LOCALAPPDATA%\Programs\Python\Python3*" 2^>nul') do (
        if not defined PYTHON_CMD call :try_python "%LOCALAPPDATA%\Programs\Python\%%D\python.exe"
    )
)

call :set_portable_env

if defined PYTHON_CMD goto :launch_python

:: --- Self-heal: no usable Python -> degrade to a direct Node launch ---
:: khy_platform.cli is a thin bootstrap; for a source checkout its launch is
:: `node backend/bin/khy.js` plus env. Replicate it here so a machine without
:: Python still reaches the same CLI instead of dying at the Python probe.
where node >nul 2>&1
if !ERRORLEVEL! neq 0 call :discover_node
if defined NODE_FOUND_DIR set "PATH=!NODE_FOUND_DIR!;!PATH!"
where node >nul 2>&1
if !ERRORLEVEL! neq 0 goto :no_runtime_error
if not exist "%~dp0runtime\node\backend\bin\khy.js" (
    echo [ERROR] Node CLI entry not found: %~dp0runtime\node\backend\bin\khy.js
    echo Please install Python 3.8+: https://www.python.org/downloads/
    exit /b 1
)
set "GATEWAY_PREFERRED_STRICT=true"
set "GATEWAY_RELAY_ENABLED=false"
:: ASCII-only messages below: cmd re-reads UTF-8 .bat lines after `chcp 65001`
:: from the wrong byte offset, executing mid-line fragments as commands (the
:: same reason the historical Chinese error text above stayed intact only by
:: luck of its byte layout). Real Chinese UX lives in the Node CLI.
echo Note: Python 3.8+ not found, falling back to direct Node launch of the same CLI.
echo Permanent fix: install Python 3.8+ (https://www.python.org/downloads/) or run "khy repair" for portable installs.
node "%~dp0runtime\node\backend\bin\khy.js" %*
exit /b !ERRORLEVEL!

:no_runtime_error
echo [ERROR] No usable Python 3.8+ and no usable Node.js found; cannot self-heal startup.
echo Checked: PATH (with store-stub probing), py launcher, in-repo runtimes, LocalAppData, common Node install locations.
echo Please install Python 3.8+: https://www.python.org/downloads/ or Node.js 20+: https://nodejs.org/
exit /b 1

:set_portable_env
:: Node is resolved by khy_platform.node_provisioner after Python starts.
:: This keeps the launcher usable on machines without a system Node install.
set "KHYQUANT_PORTABLE_ROOT=%~dp0"
set "KHY_PORTABLE_ROOT=%~dp0"
set "KHY_OS_ROOT=%~dp0"
:: W9' (2026-10-02) moved the project/base data homes into works\data — pin the
:: env to those real roots; the old .khy pins forked CLI data onto a stale home.
if not defined KHY_DATA_HOME set "KHY_DATA_HOME=%~dp0works\data\khy"
if not defined KHY_PROJECT_DATA_HOME set "KHY_PROJECT_DATA_HOME=%~dp0works\data\khy"
if not defined KHYQUANT_DATA_HOME set "KHYQUANT_DATA_HOME=%KHY_DATA_HOME%"
set "KHYOS_HOME=%~dp0works\data\khyos"
set "KHY_COORDINATOR_MODE=true"
set "KHY_RUNTIME_HOME=%KHY_DATA_HOME%\runtime"
set "KHY_CACHE_HOME=%KHY_DATA_HOME%\cache"
set "KHY_LOG_HOME=%KHY_DATA_HOME%\logs"
set "KHY_TEMP_HOME=%KHY_DATA_HOME%\tmp"
set "KHY_PLATFORM_PATH=%~dp0runtime\substrate\platform"
set "KHY_INVOKED_AS=khy"
set "KHYQUANT_ROOT=%~dp0runtime\node\backend"
set "KHYQUANT_INVOKED_AS=khy"
exit /b 0

:launch_python
%PYTHON_CMD% -c "import sys,runpy; sys.path[:0]=[r'%KHY_PLATFORM_PATH%', r'%~dp0software\khyquant']; sys.argv=['khy']+sys.argv[1:]; runpy.run_module('khy_platform', run_name='__main__')" %*
exit /b %ERRORLEVEL%

:: Probe one candidate python: run a version query and accept only real 3.8+.
:: The probe writes stdout to a temp file instead of a `for /f` in-clause so a
:: quoted path (spaces in "Program Files") survives; the WindowsApps stub
:: answers with nothing and a non-zero code, so probing (not `where`) is what
:: tells fakes from real installs.
:try_python
if defined PYTHON_CMD exit /b 0
if not exist "%~1" exit /b 0
set "PY_PROBE_FILE=%TEMP%\khy_pyver_%RANDOM%.txt"
:: `call` is required: invoking a .bat candidate without it transfers control
:: and never returns to this launcher (exe candidates are unaffected either way).
call "%~1" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" >"%PY_PROBE_FILE%" 2>nul
:: findstr admits only pure N.N lines (trailing spaces tolerated), so
:: store-alias hint text can never reach the numeric comparison below; the
:: trailing space must also be a delimiter or `if N geq M` silently degrades
:: to string comparison ("13 " < "8" is true in string order).
for /f "tokens=1,2 delims=. " %%A in ('findstr /r /c:"^[0-9][0-9]*\.[0-9][0-9]* *$" "%PY_PROBE_FILE%" 2^>nul') do (
    if %%A geq 3 (
        if %%A equ 3 (
            if %%B geq 8 set "PYTHON_CMD="%~1""
        ) else (
            set "PYTHON_CMD="%~1""
        )
    )
)
del /q "%PY_PROBE_FILE%" 2>nul
exit /b 0

:discover_node
:: :consider_node_version compares against these; unset values would turn
:: `if N gtr ` into a batch syntax error and abort the discovery.
set "KHY_BEST_MAJOR=0"
set "KHY_BEST_MINOR=0"
set "KHY_FNM_BASE=%FNM_DIR%"
if not defined KHY_FNM_BASE if defined APPDATA set "KHY_FNM_BASE=%APPDATA%\fnm"
if defined KHY_FNM_BASE if exist "!KHY_FNM_BASE!\node-versions" (
    for /f "delims=" %%D in ('dir /b /ad "!KHY_FNM_BASE!\node-versions" 2^>nul') do (
        if exist "!KHY_FNM_BASE!\node-versions\%%D\installation\node.exe" (
            call :consider_node_version "%%D" "!KHY_FNM_BASE!\node-versions\%%D\installation"
        )
    )
)
if defined NODE_FOUND_DIR exit /b 0
if defined NVM_SYMLINK if exist "%NVM_SYMLINK%\node.exe" set "NODE_FOUND_DIR=%NVM_SYMLINK%" & exit /b 0
if defined NVM_HOME if exist "%NVM_HOME%" (
    for /f "delims=" %%D in ('dir /b /ad "%NVM_HOME%" 2^>nul') do (
        if exist "%NVM_HOME%\%%D\node.exe" call :consider_node_version "%%D" "%NVM_HOME%\%%D"
    )
)
if defined NODE_FOUND_DIR exit /b 0
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_FOUND_DIR=%ProgramFiles%\nodejs" & exit /b 0
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_FOUND_DIR=%ProgramFiles(x86)%\nodejs" & exit /b 0
if defined VOLTA_HOME if exist "%VOLTA_HOME%\bin\node.exe" set "NODE_FOUND_DIR=%VOLTA_HOME%\bin" & exit /b 0
if defined LOCALAPPDATA if exist "%LOCALAPPDATA%\Volta\bin\node.exe" set "NODE_FOUND_DIR=%LOCALAPPDATA%\Volta\bin" & exit /b 0
if defined LOCALAPPDATA if exist "%LOCALAPPDATA%\khy\node" (
    for /f "delims=" %%D in ('dir /b /ad "%LOCALAPPDATA%\khy\node" 2^>nul') do (
        for /f "delims=" %%F in ('dir /b /s "%LOCALAPPDATA%\khy\node\%%D\node.exe" 2^>nul') do (
            call :consider_node_version "%%D" "%%~dpF"
        )
    )
)
if exist "%~dp0.khy\node" (
    for /f "delims=" %%D in ('dir /b /ad "%~dp0.khy\node" 2^>nul') do (
        for /f "delims=" %%F in ('dir /b /s "%~dp0.khy\node\%%D\node.exe" 2^>nul') do (
            call :consider_node_version "%%D" "%%~dpF"
        )
    )
)
exit /b 0

:consider_node_version
set "KHY_VER=%~1"
if /i "!KHY_VER:~0,1!"=="v" set "KHY_VER=!KHY_VER:~1!"
set "KHY_MAJ_RAW=0"
set "KHY_MIN_RAW=0"
for /f "tokens=1,2 delims=." %%A in ("!KHY_VER!") do (
    set "KHY_MAJ_RAW=%%A"
    if not "%%B"=="" set "KHY_MIN_RAW=%%B"
)
set "KHY_MAJ_NUM=0"
set "KHY_MIN_NUM=0"
2>nul set /a "KHY_MAJ_NUM=KHY_MAJ_RAW"
2>nul set /a "KHY_MIN_NUM=KHY_MIN_RAW"
if !KHY_MAJ_NUM! geq 20 (
    if !KHY_MAJ_NUM! gtr !KHY_BEST_MAJOR! (
        set "NODE_FOUND_DIR=%~2"
        set "KHY_BEST_MAJOR=!KHY_MAJ_NUM!"
        set "KHY_BEST_MINOR=!KHY_MIN_NUM!"
    ) else if !KHY_MAJ_NUM! equ !KHY_BEST_MAJOR! if !KHY_MIN_NUM! gtr !KHY_BEST_MINOR! (
        set "NODE_FOUND_DIR=%~2"
        set "KHY_BEST_MINOR=!KHY_MIN_NUM!"
    )
)
exit /b 0
