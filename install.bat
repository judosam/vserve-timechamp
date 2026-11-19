@echo off
title Vserve-TimeChamp 1-Click Installer
echo ========================================================
echo        Vserve-TimeChamp - 1-Click Installer
echo ========================================================
echo.
echo Installing agent and watchdog silently for current user...
echo (No administrator rights required)
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\install.ps1" -StartNow

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ========================================================
    echo [SUCCESS] Vserve-TimeChamp is installed and running!
    echo - Agent: Running silently in background
    echo - Watchdog: Running in background (auto-restart protection)
    echo - Auto-Start: Enabled at user logon
    echo ========================================================
) else (
    echo.
    echo [ERROR] Installation encountered an error (Code: %ERRORLEVEL%).
)

echo.
pause
