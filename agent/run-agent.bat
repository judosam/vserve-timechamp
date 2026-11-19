@echo off
rem Work Timer - Silent Agent Invoker
rem Runs agent silently via launcher.vbs or hidden powershell
set SCRIPT_DIR=%~dp0
if exist "%SCRIPT_DIR%launcher.vbs" (
    start "" wscript.exe "%SCRIPT_DIR%launcher.vbs" "%SCRIPT_DIR%agent.ps1"
) else (
    start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%SCRIPT_DIR%agent.ps1"
)
exit /b 0
