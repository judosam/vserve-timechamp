<#
.SYNOPSIS
    Vserve-TimeChamp - Uninstaller
.DESCRIPTION
    Stops running agent and watchdog processes, removes auto-start registration (HKCU Run key and/or Scheduled Task),
    and removes deployed binaries.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$InstallDir = "$env:LOCALAPPDATA\VserveTimeChamp",

    [Parameter(Mandatory = $false)]
    [switch]$RemoveData
)

$resolvedInstallDir = [System.Environment]::ExpandEnvironmentVariables($InstallDir)
Write-Host "Uninstalling Vserve-TimeChamp from: $resolvedInstallDir"

# 1. Stop Watchdog first
$watchdogPs1 = Join-Path $resolvedInstallDir "vserve-watchdog.ps1"
if (Test-Path $watchdogPs1) {
    & $watchdogPs1 -Stop | Out-Null
}
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'vserve-watchdog\.ps1' -or $_.CommandLine -match 'launcher-watchdog\.vbs' } | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

# 2. Stop running agent processes
Write-Host "Stopping running agent processes..."
$agentPs1 = Join-Path $resolvedInstallDir "agent.ps1"
if (Test-Path $agentPs1) {
    & $agentPs1 -Stop | Out-Null
} else {
    Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'agent\.ps1' -or $_.CommandLine -match 'launcher\.vbs' } | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}
Start-Sleep -Milliseconds 500

# 3. Remove HKCU Run keys
$runKeyPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$keysToRemove = @("VserveTimeChampAgent", "VserveTimeChampWatchdog", "WorkTimerAgent")
foreach ($k in $keysToRemove) {
    $existing = Get-ItemProperty -Path $runKeyPath -Name $k -ErrorAction SilentlyContinue
    if ($existing) {
        Remove-ItemProperty -Path $runKeyPath -Name $k -Force -ErrorAction SilentlyContinue
        Write-Host "Removed HKCU Run key '$k'."
    }
}

# 4. Remove Scheduled Tasks
$tasksToRemove = @("VserveTimeChampAgent", "VserveTimeChampWatchdog", "WorkTimerAgent")
foreach ($t in $tasksToRemove) {
    try {
        $schCheck = schtasks.exe /Query /TN $t 2>&1
        if ($LASTEXITCODE -eq 0) {
            schtasks.exe /Delete /TN $t /F 2>&1 | Out-Null
            Write-Host "Deleted Scheduled Task '$t'."
        }
    } catch {}
}

# 5. Remove binaries and scripts
$binaries = @(
    "agent.ps1",
    "launcher.vbs",
    "run-agent.bat",
    "Sync-Transport.ps1",
    "Vserve-ActivityTracker.ps1",
    "vserve-watchdog.ps1",
    "launcher-watchdog.vbs"
)
foreach ($bin in $binaries) {
    $p = Join-Path $resolvedInstallDir $bin
    if (Test-Path $p) {
        Remove-Item -Path $p -Force -ErrorAction SilentlyContinue
        Write-Host "Removed $bin"
    }
}

# 6. Remove data files if requested
if ($RemoveData) {
    Write-Host "Removing data files and logs..."
    if (Test-Path $resolvedInstallDir) {
        Remove-Item -Path $resolvedInstallDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    Write-Host "Data directory removed."
} else {
    Write-Host "Note: Daily CSVs and logs retained in '$resolvedInstallDir'. Use -RemoveData to delete them."
}

Write-Host "Vserve-TimeChamp uninstalled successfully."
