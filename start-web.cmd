@echo off
rem ============================================================================
rem start-web.cmd - double-click entry for the Khy OS web UI.
rem
rem ASCII-only output on purpose. cmd re-reads a UTF-8 .bat line after
rem `chcp 65001` from the wrong byte offset and executes mid-line fragments as
rem commands; khy.bat documents the same constraint. Real Chinese UX lives in
rem the Node CLI and in the browser page.
rem
rem Lives at the repo root next to khy.bat because it is the web face of that
rem same CLI, not a separate app: it resolves its own root from %~dp0 and hands
rem straight over, so the portable env contract in khy-env.bat applies as-is.
rem ============================================================================
setlocal
set "ROOT=%~dp0"

if not exist "%ROOT%khy.bat" (
    echo [ERR] khy.bat not found next to this launcher: %ROOT%
    echo        The repo looks moved or incomplete.
    pause
    exit /b 1
)

rem Two flags, both about speed and staying up:
rem   --no-auto-frontend  serve the prebuilt delivery/web/ai-frontend/dist instead
rem                       of spawning a Vite dev server (cold compile ~11s, plus the
rem                       CLI then polls for it). The dist is the fallback path the
rem                       daemon already implements, so nothing new is wired up.
rem                       Rebuild it with: cd delivery\web\ai-frontend && npm run build
rem   --idle-ms 7200000   the daemon kills itself after 600s with no session, which
rem                       left the browser pointed at a dead backend. Two hours.
rem `open` is explicit even though it is the default action: it is the branch that
rem actually opens the browser, while `start` only boots the session and prints
rem the URL. Passing it makes the intent survive a future default change.
rem No URLs are hardcoded here on purpose: endpoints come from the CLI's own
rem runtime resolution (RUNTIME-001), and the daemon publishes the real entry path.
call "%ROOT%khy.bat" web open --no-auto-frontend --idle-ms 7200000

if errorlevel 1 (
    echo.
    echo [ERR] khy web exited with code %ERRORLEVEL%.
    echo        Re-run in a terminal to read the full message: khy web
    pause
)
endlocal
