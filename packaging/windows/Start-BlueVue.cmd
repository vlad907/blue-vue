@echo off
rem Runs Blue Vue in this window, without installing it, to try it out.
rem Data goes in a "data" folder here. Close the window to stop it.
rem Add "simulate" to try it with no real devices:  Start-BlueVue.cmd simulate
cd /d "%~dp0"
if /i "%~1"=="simulate" set BLUEVUE_SIMULATE=1
"%~dp0runtime\node.exe" "%~dp0app\server.mjs" "%~dp0config\system.json"
pause
