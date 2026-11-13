@echo off
rem Double-click to remove Blue Vue from this PC. Its data (devices, scenes,
rem admin password) is kept in C:\ProgramData\BlueVue.
net session >nul 2>&1
if errorlevel 1 (
  echo Asking Windows for administrator permission...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall-server.ps1" %*
echo.
echo You can close this window.
pause >nul
