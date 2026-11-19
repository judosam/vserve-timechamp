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
pause
