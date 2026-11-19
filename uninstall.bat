@echo off
title Vserve-TimeChamp 1-Click Uninstaller
echo ========================================================
echo       Vserve-TimeChamp - 1-Click Uninstaller
echo ========================================================
echo.
echo Stopping agent and watchdog processes...
echo Removing logon auto-start and deployed files...
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\uninstall.ps1" -RemoveData

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ========================================================
    echo [SUCCESS] Vserve-TimeChamp has been completely uninstalled.
    echo All background processes stopped and startup keys removed.
    echo ========================================================
) else (
    echo.
    echo [ERROR] Uninstallation encountered an issue (Code: %ERRORLEVEL%).
)

echo.
pause
