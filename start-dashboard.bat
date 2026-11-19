@echo off
title Vserve-TimeChamp Live Dashboard Server
echo ========================================================
echo     Vserve-TimeChamp - Live Dashboard Server
echo ========================================================
echo.

echo Starting dashboard server on http://localhost:3000...
echo.

start "" "http://localhost:3000"
node "%~dp0admin\server.js"
if errorlevel 1 (
    echo.
    echo Server stopped or port 3000 occupied.
    echo Run stop-dashboard.bat to free port 3000 if needed.
)
pause
