@echo off
REM =============================================================================
REM khy-env.bat - single source of truth for the KHY_* environment contract
REM =============================================================================
REM
REM Four entry points reach the same Node CLI:
REM   khy-os\khy.bat                (Python-preferred launcher)
REM   khy-os\khy-cli.bat            (shortcut, now delegates to khy.bat)
REM   <PORTABLE_ROOT>\bin\khy.cmd   (the one on PATH, used outside the repo)
REM   <PORTABLE_ROOT>\bin\khy-os.cmd
REM
REM They used to declare their own subsets. khy-cli.bat and bin\khy.cmd set no
REM KHY_* variable at all, so they silently forked the data home onto a
REM different tree than khy.bat did -- two caches, two session stores, and a
REM `metadata` command that wrote its output relative to the caller's cwd.
REM `call` this file instead of re-declaring the contract.
REM
REM Portability: every path is derived from %~dp0 (this file's own directory).
REM No literal drive letter, no user directory.

set "KHY_ENV_ROOT=%~dp0"

set "KHYQUANT_PORTABLE_ROOT=%KHY_ENV_ROOT%"
set "KHY_PORTABLE_ROOT=%KHY_ENV_ROOT%"
set "KHY_OS_ROOT=%KHY_ENV_ROOT%"

REM W9' (2026-10-02) moved the project/base data homes into works\data -- pin the
REM env to those real roots; the old .khy pins forked CLI data onto a stale home.
if not defined KHY_DATA_HOME set "KHY_DATA_HOME=%KHY_ENV_ROOT%works\data\khy"
if not defined KHY_PROJECT_DATA_HOME set "KHY_PROJECT_DATA_HOME=%KHY_ENV_ROOT%works\data\khy"
if not defined KHYQUANT_DATA_HOME set "KHYQUANT_DATA_HOME=%KHY_DATA_HOME%"

set "KHYOS_HOME=%KHY_ENV_ROOT%works\data\khyos"
set "KHY_COORDINATOR_MODE=true"
set "KHY_RUNTIME_HOME=%KHY_DATA_HOME%\runtime"
set "KHY_CACHE_HOME=%KHY_DATA_HOME%\cache"
set "KHY_LOG_HOME=%KHY_DATA_HOME%\logs"
set "KHY_TEMP_HOME=%KHY_DATA_HOME%\tmp"
set "KHY_PLATFORM_PATH=%KHY_ENV_ROOT%runtime\substrate\platform"
set "KHY_INVOKED_AS=khy"
set "KHYQUANT_ROOT=%KHY_ENV_ROOT%runtime\node\backend"
set "KHYQUANT_INVOKED_AS=khy"

exit /b 0
