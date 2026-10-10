@echo off
setlocal EnableExtensions
:: Thin wrapper: portable-setup.bat lives at the repo root, five levels up
:: (delivery/extension/scripts/khy-installer/setup/ -> khy-installer -> scripts -> extension -> delivery -> root).
call "%~dp0..\..\..\..\..\portable-setup.bat" %*
exit /b %ERRORLEVEL%
