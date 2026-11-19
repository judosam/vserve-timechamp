@echo off
title Stop Vserve-TimeChamp Live Dashboard Server
echo ========================================================
echo     Stopping Vserve-TimeChamp Dashboard Server
echo ========================================================
echo.

set FOUND=0
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000" ^| findstr "LISTENING"') do (
    echo Terminating server process PID %%a listening on port 3000...
    taskkill /F /PID %%a >nul 2>&1
    set FOUND=1
)

if "%FOUND%"=="1" (
    echo [OK] Vserve-TimeChamp Dashboard Server on port 3000 stopped.
) else (
    echo [INFO] No server instance found listening on port 3000.
)

echo.
pause
