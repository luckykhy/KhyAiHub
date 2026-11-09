@echo off
REM =============================================================================
REM khy-cli.bat - Khy-OS CLI shortcut
REM =============================================================================
REM
REM Delegates to khy.bat instead of spawning node directly. It used to be
REM `node "%~dp0runtime\node\backend\bin\khy.js" %*` with no environment at
REM all, which meant the data home, cache and session store forked onto a
REM different tree than every other entry point -- one machine, two states.
REM Going through khy.bat costs a cached Python probe (~0ms after the first
REM run) and buys the same 16-var KHY_* contract, the same --help/--version
REM fast path, and the same `khy repair` interception.

call "%~dp0khy.bat" %*
exit /b %ERRORLEVEL%
