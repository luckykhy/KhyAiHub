@echo off
setlocal enabledelayedexpansion
:: Tell bin/khy.js the console is already on 65001 so it can skip its own
:: synchronous chcp.com spawn (measured 230-475ms on the startup path). The
:: Python launcher exports the same handshake from cli.py:2503; this line
:: covers the direct-Node paths (khy-cli.bat, bin/khy.cmd, the Node fallback
:: below) that never go through Python. Only exported on success: a failed
:: chcp means the console is still on a legacy codepage and khy.js must flip
:: it. KHY_FORCE_CHCP=1 in khy.js restores the unconditional spawn.
chcp 65001 >nul
if !ERRORLEVEL! equ 0 set "KHY_CONSOLE_CP=65001"

:: =============================================================================
:: khy.bat - Windows launcher for Khy-OS CLI
:: =============================================================================

:: --- Proxy env vars: preserved (required for China network: agnes blocked without proxy) ---
:: set "HTTP_PROXY="
:: set "HTTPS_PROXY="
:: set "http_proxy="
:: set "https_proxy="

:: --- Data home, resolved before anything that needs it ---
:: :set_portable_env below sets the same values under the same `if not defined`
:: guards, so this early copy is only a forward declaration; the full contract
:: (16 KHY_* vars) still comes from :set_portable_env. It has to come this early
:: because the Python-probe cache and the `khy repair` invalidation both run
:: before :set_portable_env is reached.
if not defined KHY_DATA_HOME set "KHY_DATA_HOME=%~dp0works\data\khy"
if not defined KHY_CACHE_HOME set "KHY_CACHE_HOME=%KHY_DATA_HOME%\cache"

:: --- khy repair: one-shot portable self-repair (Node only, bypasses python cli) ---
:: The probe cache is dropped here: repair may provision a portable Python, and
:: a cached "none" would keep sending us to Node until the PATH signature moved.
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
    del /q "%KHY_CACHE_HOME%\py-probe.txt" >nul 2>&1
    node "%~dp0delivery\extension\scripts\khy-portable\repair-portable.js" %2 %3 %4 %5 %6 %7 %8 %9
    exit /b !ERRORLEVEL!
)

:: --- Fast path: --help / --version never need the Python probe ---
:: The probe below costs seconds on machines without a real Python (every
:: candidate is a WindowsApps store-alias stub that exits 49), and neither
:: flag is implemented by the Python launcher anyway. Answer from Node.
:: :set_portable_env is still called so the data home matches khy.bat exactly.
for %%A in (--version -v --help -h) do if "%~1"=="%%A" goto :fast_node

:: --- Python probe, with a negative-result cache ---
:: The probe is two `where` scans of a 30-entry PATH plus a `py -3` spawn
:: (~1.6s here), and its answer only changes when PATH does. Cache it keyed on
:: a PATH signature (first/last 48 chars) so the common "no Python" box pays it
:: once, not once per command. Misses in the middle of PATH are not detected;
:: the failure mode is benign (we fall through to the Node launch, which is the
:: same CLI) and `khy repair` / KHY_PY_PROBE_REFRESH=1 force a re-probe.
set "PY_CACHE=%KHY_CACHE_HOME%\py-probe.txt"
set "PYSIG1=%PATH:~0,48%"
set "PYSIG2=%PATH:~-48%"
set "PYSIG_HITS=0"
set "PY_CACHED="
if not defined KHY_PY_PROBE_REFRESH if exist "%PY_CACHE%" (
    for /f "usebackq tokens=1,* delims==" %%A in ("%PY_CACHE%") do (
        if /i "%%A"=="sig1" if "%%B"=="%PYSIG1%" set /a PYSIG_HITS+=1
        if /i "%%A"=="sig2" if "%%B"=="%PYSIG2%" set /a PYSIG_HITS+=1
        if /i "%%A"=="py" set "PY_CACHED=%%B"
    )
)
:: Both signature lines must match: a single match means a truncated or
:: hand-edited cache, which is treated as a miss rather than a stale hit.
if !PYSIG_HITS! equ 2 (
    if /i not "!PY_CACHED!"=="none" (
        REM 缓存值有两种形态：单个可执行文件路径，或「命令 + 参数」（如 `py -3`）。
        REM 原来只用 `if exist "!PY_CACHED!"` 判存在性 —— 对 `py -3` 这种多 token 值，
        REM if exist 拿整串当路径去问磁盘，必然不存在 ⇒ 缓存**读不回来**：
        REM   · 每次启动都要重新探测一遍（白付那次探测的钱）；
        REM   · 一旦这次探测没成功，回写就把缓存写成 none —— 于是「本来有 Python 的机器」
        REM     被永久降级成走 Node 直启，且要等 PATH 签名变了才恢复。
        REM 现在分形态判：单 token 按路径判存在；多 token 判第一个 token 在不在 PATH 上。
        set "PY_CACHED_FIRST="
        for /f "tokens=1" %%F in ("!PY_CACHED!") do set "PY_CACHED_FIRST=%%F"
        if defined PY_CACHED_FIRST (
            set "PY_CACHED_MULTI=0"
            if not "!PY_CACHED: =!"=="!PY_CACHED!" set "PY_CACHED_MULTI=1"
            if "!PY_CACHED_MULTI!"=="0" (
                if exist "!PY_CACHED_FIRST!" set "PYTHON_CMD=!PY_CACHED!"
            ) else (
                where "!PY_CACHED_FIRST!" >nul 2>&1
                if !ERRORLEVEL! equ 0 set "PYTHON_CMD=!PY_CACHED!"
            )
        )
    )
    goto :python_probe_done
)

:: --- In-repo runtimes first: if `khy repair` has provisioned a portable
:: Python, no PATH scan is needed at all. Probed before the PATH loop so the
:: common portable case costs one stat instead of two `where` runs.
set "PYTHON_CMD="
for %%F in (
    "%~dp0runtime\python\python.exe"
    "%~dp0.khy\python\python.exe"
) do if not defined PYTHON_CMD call :try_python "%%~fF"

:: --- Detect Python 3.8+ ---

:: Probe every absolute path `where` returns, not just the first name: the
:: WindowsApps store-alias stub (python.exe present, exits 9009, no stdout)
:: shadows a real install later in PATH, so each candidate must be probed.
:: The stub is recognised from `where` output alone (its path contains
:: \WindowsApps\) and never executed: launching it costs ~1s each and always
:: fails, which is the single largest slice of startup on a Python-less box.
for %%P in (python3 python) do (
    if not defined PYTHON_CMD (
        for /f "delims=" %%I in ('where %%P 2^>nul') do (
            if not defined PYTHON_CMD (
                set "PYCAND=%%~fI"
                if "!PYCAND:\WindowsApps\=!"=="!PYCAND!" call :try_python "%%~fI"
            )
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

if not defined PYTHON_CMD if defined LOCALAPPDATA if exist "%LOCALAPPDATA%\Programs\Python" (
    for /f "delims=" %%D in ('dir /b /ad /o-n "%LOCALAPPDATA%\Programs\Python\Python3*" 2^>nul') do (
        if not defined PYTHON_CMD call :try_python "%LOCALAPPDATA%\Programs\Python\%%D\python.exe"
    )
)

:python_probe_done
:: Persist the probe answer for the next launch. Written only when the caller
:: did not ask for a forced re-probe, so KHY_PY_PROBE_REFRESH=1 / `khy repair`
:: never write a cache they were meant to bypass. PATH containing a batch
:: metacharacter cannot be echoed safely, so such machines simply never cache
:: and keep paying the probe (correct, just not faster).
if not defined KHY_PY_PROBE_REFRESH (
    set "PY_ECHO_SAFE=1"
    if not "%PATH:&=%"=="%PATH%" set "PY_ECHO_SAFE=0"
    if not "%PATH:|=%"=="%PATH%" set "PY_ECHO_SAFE=0"
    if not "%PATH:<=%"=="%PATH%" set "PY_ECHO_SAFE=0"
    if not "%PATH:>=%"=="%PATH%" set "PY_ECHO_SAFE=0"
    if "!PY_ECHO_SAFE!"=="1" (
        if not exist "%KHY_CACHE_HOME%" md "%KHY_CACHE_HOME%" >nul 2>&1
        set "PY_OUT=none"
        if defined PYTHON_CMD set "PY_OUT=!PYTHON_CMD!"
        REM Delayed expansion on the echo line too: inside a parenthesised
        REM block every %VAR% is expanded once, when the block is parsed --
        REM which is before `set PY_OUT=none` above has run.
        >"%PY_CACHE%" echo sig1=%PYSIG1%
        >>"%PY_CACHE%" echo sig2=%PYSIG2%
        >>"%PY_CACHE%" echo py=!PY_OUT!
    )
)

call :set_portable_env
if errorlevel 1 exit /b 1

if defined PYTHON_CMD goto :launch_python

:: --- Self-heal: no usable Python -> degrade to a direct Node launch ---
:: khy_platform.cli is a thin bootstrap; for a source checkout its launch is
:: `node backend/bin/khy.js` plus env. Replicate it here so a machine without
:: Python still reaches the same CLI instead of dying at the Python probe.
:: One PATH scan for node, not two: if the first `where node` succeeded the
:: second cannot change the answer, and PATH here has 20+ entries.
set "NODE_OK=0"
where node >nul 2>&1
if !ERRORLEVEL! equ 0 set "NODE_OK=1"
if !NODE_OK! equ 0 call :discover_node
if defined NODE_FOUND_DIR set "PATH=!NODE_FOUND_DIR!;!PATH!"
if !NODE_OK! equ 0 (
    where node >nul 2>&1
    if !ERRORLEVEL! equ 0 set "NODE_OK=1"
)
if !NODE_OK! equ 0 goto :no_runtime_error
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
:: The fallback note is printed once per data home, not once per launch: it
:: describes an environment fact, and re-printing it on every command both
:: spams scripts/CI output and misleads — the Node fallback below works, so
:: "Permanent fix: install Python" is not an action the user needs to take.
:: Delete the marker file to see it again.
set "PYNOTE_FILE=%KHY_CACHE_HOME%\python-fallback-noted"
if not exist "%PYNOTE_FILE%" (
    echo Note: Python 3.8+ not found, launching the same CLI directly through Node.
    echo This machine works fine as-is; install Python only if you need the Python toolchain.
    if not exist "%KHY_CACHE_HOME%" md "%KHY_CACHE_HOME%" >nul 2>&1
    REM Prefix form, not `echo ok>"%FILE%" >nul`: cmd keeps only the last
    REM redirect for a handle, so the trailing >nul would leave the marker
    REM uncreated and the note would print on every launch.
    >"%PYNOTE_FILE%" echo ok
)
node "%~dp0runtime\node\backend\bin\khy.js" %*
exit /b !ERRORLEVEL!

:fast_node
:: --help / --version answered without the Python probe. Same env contract as
:: :set_portable_env so the data home does not fork from the Python path.
call :set_portable_env
if errorlevel 1 exit /b 1
set "NODE_OK=0"
where node >nul 2>&1
if !ERRORLEVEL! equ 0 set "NODE_OK=1"
if !NODE_OK! equ 0 call :discover_node
if defined NODE_FOUND_DIR set "PATH=!NODE_FOUND_DIR!;!PATH!"
if !NODE_OK! equ 0 (
    where node >nul 2>&1
    if !ERRORLEVEL! equ 0 set "NODE_OK=1"
)
if !NODE_OK! equ 0 goto :no_runtime_error
node "%~dp0runtime\node\backend\bin\khy.js" %*
exit /b !ERRORLEVEL!

:no_runtime_error
echo [ERROR] No usable Python 3.8+ and no usable Node.js found; cannot self-heal startup.
echo Checked: PATH (with store-stub probing), py launcher, in-repo runtimes, LocalAppData, common Node install locations.
echo Please install Python 3.8+: https://www.python.org/downloads/ or Node.js 20+: https://nodejs.org/
exit /b 1

:set_portable_env
:: The 16-var KHY_* contract lives in khy-env.bat so that khy-cli.bat and
:: <PORTABLE_ROOT>\bin\khy.cmd can share it instead of each declaring a subset
:: (they used to declare none, which forked the data home onto a second tree).
:: khy-env.bat derives every path from its own %~dp0, so calling it from here
:: yields the same values this label used to hardcode. The two root vars are
:: declared here first anyway: a launcher must be able to name its own root
:: even when the sibling contract file is absent, and portableHostIsolation
:: pins `set "KHY_PORTABLE_ROOT=%~dp0"` on this file.
set "KHYQUANT_PORTABLE_ROOT=%~dp0"
set "KHY_PORTABLE_ROOT=%~dp0"
:: The contract file MUST be there. `call` on a missing file prints an error,
:: sets ERRORLEVEL=1 and then CONTINUES -- so without this check a checkout
:: that lacks khy-env.bat would go on to launch with NONE of the KHY_*
:: variables set: the data home would fall back to a default and the
:: session/cache tree would fork. That is the same class of bug B8 records
:: for cwd-relative data homes (two trees because of an ambient value), and
:: it is exactly what khy-env.bat was extracted to prevent.
if not exist "%~dp0khy-env.bat" (
    echo [ERROR] Missing khy-env.bat next to khy.bat.
    echo         khy-env.bat holds the shared KHY_* environment contract.
    echo         Restore it from the repository: git ls-files khy-env.bat
    exit /b 1
)
call "%~dp0khy-env.bat"
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
