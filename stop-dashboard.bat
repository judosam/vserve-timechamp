@echo off
title Stop Vserve-TimeChamp Live Dashboard Server
echo ========================================================
echo     Stopping Vserve-TimeChamp Dashboard Server
echo ========================================================
echo.

taskkill /F /FI "WINDOWTITLE eq Vserve-TimeChamp Live Dashboard Server*" >nul 2>&1
echo [OK] Vserve-TimeChamp dashboard server stopped.
echo.
pause
