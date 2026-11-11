@echo off
REM Starts the shuttle website. Settings come from the .env file in this folder.
cd /d "%~dp0"
title Shuttle website

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  PROBLEM: Node.js is not installed, or Windows can't find it.
  echo  Install the LTS version from https://nodejs.org then restart the PC.
  goto :fail
)

node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 (
  echo.
  echo  PROBLEM: This Node.js version is too old. Version 22.13 or newer is needed.
  node --version
  echo  Install the LTS version from https://nodejs.org then try again.
  goto :fail
)

if not exist "node_modules\express" (
  echo.
  echo  First run: installing the app's parts. This takes a minute...
  call npm install --omit=dev
  if errorlevel 1 goto :fail
)

if not exist ".env" (
  echo.
  echo  NOTE: No .env settings file found. Starting with default settings.
  echo  Copy .env.example to .env and fill it in to set your admin login.
)

echo.
echo  Starting... Leave this window open. Open http://localhost:3000 in a browser.
echo.
node --env-file-if-exists=.env src\server.js
echo.
echo  The shuttle website stopped. The message above says why.

:fail
echo.
pause
