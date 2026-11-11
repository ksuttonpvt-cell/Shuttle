@echo off
REM Starts the shuttle website. Settings come from the .env file in this folder.
cd /d "%~dp0"
node --env-file-if-exists=.env src\server.js
