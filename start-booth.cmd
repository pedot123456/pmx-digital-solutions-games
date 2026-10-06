@echo off
rem -------------------------------------------------------------------------
rem  PMX Digital Challenge - Word Rush: start the booth server (Windows).
rem  Double-click this file. Keep the window open during the event.
rem -------------------------------------------------------------------------
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  rem No Node.js installed: use a portable copy if one was unzipped under %TEMP%\pmxbuild.
  for /d %%D in ("%TEMP%\pmxbuild\node-v*-win-x64") do set "PATH=%%~fD;%PATH%"
)
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js was not found. Install the LTS version from https://nodejs.org
  echo  ^(or ask IT^), then run this file again.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies ^(first run only^)...
  call npm.cmd install --no-audit --no-fund
  if errorlevel 1 goto :fail
)

if not exist dist\client\index.html (
  echo Building the app ^(first run only^)...
  call npm.cmd run build
  if errorlevel 1 goto :fail
)

rem Open the game in the browser a few seconds after the server has started.
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 5; Start-Process 'http://localhost:8090/#/'"

call npm.cmd start
goto :eof

:fail
echo.
echo  Something went wrong - see the messages above.
pause
exit /b 1
