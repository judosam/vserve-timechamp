@echo off
title Vserve-TimeChamp Live Dashboard Server
echo ========================================================
echo     Vserve-TimeChamp - Live Dashboard Server
echo ========================================================
echo.

:: Automatically free up port 3000 if an older server instance is running
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000" ^| findstr "LISTENING"') do (
    echo Freeing up port 3000 (terminating existing PID %%a)...
    taskkill /F /PID %%a >nul 2>&1
)

echo Starting dashboard server on http://localhost:3000...
echo.

start "" "http://localhost:3000"
node "%~dp0admin\server.js"
pause
