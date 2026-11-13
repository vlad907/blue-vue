@echo off
rem Double-click to install or update Blue Vue on this PC.
rem Windows asks for permission once; nothing needs typing.
net session >nul 2>&1
if errorlevel 1 (
  echo Asking Windows for administrator permission...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-server.ps1" %*
echo.
echo You can close this window.
pause >nul
