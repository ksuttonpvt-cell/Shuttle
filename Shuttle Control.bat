@echo off
REM Opens Shuttle Control: status, live log, Start / Stop / Restart for the shuttle website.
REM Works only on this PC, while start-shuttle.bat is running.
set PORT=3001
if exist "%~dp0.env" for /f "usebackq tokens=1,* delims==" %%a in ("%~dp0.env") do if /i "%%a"=="CONTROL_PORT" set PORT=%%b
start "" msedge --app=http://127.0.0.1:%PORT% --window-size=1100,800 2>nul
if errorlevel 1 start "" http://127.0.0.1:%PORT%
