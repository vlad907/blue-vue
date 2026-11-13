@echo off
rem Updates (or installs) Blue Vue on this PC. Double-click it.
rem It gets the newest version from GitHub, installs it and restarts the
rem server. Devices, scenes and the admin password are kept.
setlocal
set "REPO=https://github.com/vlad907/blue-vue"
set "PACKAGE=BlueVue-Server-0.1.0-win-x64.zip"
set "WORK=%ProgramData%\BlueVue\update"
if /i "%~1"=="install" goto install

rem Step 1, as the normal user: if this file sits in a copy of the project
rem made with git, bring that copy up to date. The whole step is one block,
rem so it still runs correctly if the update changes this file.
(
  if exist "%~dp0.git" (
    where git >nul 2>&1 && (
      echo Getting the newest version...
      git -C "%~dp0." pull --ff-only
    )
  )
  echo Asking Windows for administrator permission...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList 'install' -Verb RunAs"
  exit /b
)

:install
rem Step 2, as administrator: unpack the package and run its installer.
if exist "%WORK%" rmdir /s /q "%WORK%"
mkdir "%WORK%"
set "ZIP=%~dp0release\%PACKAGE%"
if not exist "%ZIP%" (
  echo Downloading Blue Vue...
  set "ZIP=%WORK%\%PACKAGE%"
  curl -L --fail -o "%WORK%\%PACKAGE%" "%REPO%/raw/main/release/%PACKAGE%"
  if errorlevel 1 goto failed
)
echo Unpacking...
tar -xf "%ZIP%" -C "%WORK%"
if errorlevel 1 goto failed
powershell -NoProfile -ExecutionPolicy Bypass -File "%WORK%\BlueVue-Server\install-server.ps1"
set "RESULT=%errorlevel%"
cd /d "%ProgramData%"
rmdir /s /q "%WORK%"
echo.
if "%RESULT%"=="0" (echo Blue Vue is up to date. You can close this window.) else (echo The update did not finish. Send a picture of this window.)
pause >nul
exit /b %RESULT%

:failed
echo.
echo Could not get the Blue Vue package. Check this PC's internet connection and try again.
pause >nul
exit /b 1
