<#
.SYNOPSIS
    Vserve-TimeChamp - Silent Background Agent & Watchdog Installer (No Admin Rights Required)
.DESCRIPTION
    Deploys Vserve-TimeChamp agent and watchdog files to %LOCALAPPDATA%\VserveTimeChamp\,
    configures silent auto-start via HKCU Run key or User Task Scheduler,
    and launches the agent and watchdog silently without console flashes.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$InstallDir = "$env:LOCALAPPDATA\VserveTimeChamp",

    [Parameter(Mandatory = $false)]
    [ValidateSet("RunKey", "TaskScheduler")]
    [string]$Method = "RunKey",

    [Parameter(Mandatory = $false)]
    [string]$CentralStorePath = "\\server\worktime",

    [Parameter(Mandatory = $false)]
    [int]$IdleThresholdSeconds = 600,

    [Parameter(Mandatory = $false)]
    [int]$TickIntervalSeconds = 30,

    [Parameter(Mandatory = $false)]
    [int]$SyncIntervalSeconds = 900,

    [Parameter(Mandatory = $false)]
    [string]$Transport = "Share",

    [Parameter(Mandatory = $false)]
    [switch]$StartNow = $true
)

$ErrorActionPreference = "Stop"

$resolvedInstallDir = [System.Environment]::ExpandEnvironmentVariables($InstallDir)
Write-Host "Installing Vserve-TimeChamp to: $resolvedInstallDir"

if (-not (Test-Path $resolvedInstallDir)) {
    New-Item -ItemType Directory -Path $resolvedInstallDir -Force | Out-Null
}

# Resolve source directories
$deployScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
if ([string]::IsNullOrEmpty($deployScriptDir)) { $deployScriptDir = (Get-Location).Path }
$rootDir = Split-Path -Parent $deployScriptDir
$agentSourceDir = Join-Path $rootDir "agent"
$syncSourceDir  = Join-Path $rootDir "sync"

# Copy agent binaries, modules, and scripts
$filesToCopy = @(
    "agent.ps1",
    "launcher.vbs",
    "run-agent.bat",
    "Vserve-ActivityTracker.ps1",
    "vserve-watchdog.ps1",
    "launcher-watchdog.vbs"
)

foreach ($f in $filesToCopy) {
    $src = Join-Path $agentSourceDir $f
    if (Test-Path $src) {
        Copy-Item -Path $src -Destination $resolvedInstallDir -Force
    }
}

Copy-Item -Path (Join-Path $syncSourceDir "Sync-Transport.ps1") -Destination $resolvedInstallDir -Force

# Generate / Update config.json
$configObj = [PSCustomObject]@{
    project = "vserve-timechamp"
    version = "1.2.0"
    agent = [PSCustomObject]@{
        user                      = [System.Environment]::UserName
        machine                   = [System.Environment]::MachineName
        localDataPath             = $resolvedInstallDir
        tickIntervalSeconds       = $TickIntervalSeconds
        idleThresholdSeconds      = $IdleThresholdSeconds
        stateFlushIntervalSeconds = $TickIntervalSeconds
        syncIntervalSeconds       = $SyncIntervalSeconds
        logLevel                  = "INFO"
        maxLogSizeBytes           = 5242880
        maxRotatedLogs            = 3
        enableAppTracking         = $true
        enableBrowserUrlTracking  = $true
        enableScreenshots         = $false
        screenshotIntervalSeconds = 600
        screenshotBlur            = $false
        enableWatchdog            = $true
        watchdogIntervalSeconds   = 60
    }
    productivityRules = [PSCustomObject]@{
        productiveApps   = @("code.exe", "devenv.exe", "idea64.exe", "excel.exe", "winword.exe", "powerpnt.exe", "teams.exe", "slack.exe", "outlook.exe", "antigravity.exe", "powershell.exe", "cmd.exe")
        unproductiveApps = @("spotify.exe", "steam.exe", "epicgameslauncher.exe", "discord.exe")
        productiveUrls   = @("github.com", "gitlab.com", "bitbucket.org", "stackoverflow.com", "learn.microsoft.com", "docs.google.com", "jira", "confluence", "vservesolution.com")
        unproductiveUrls = @("facebook.com", "instagram.com", "twitter.com", "x.com", "tiktok.com", "netflix.com", "reddit.com")
    }
    sync  = [PSCustomObject]@{
        transport = $Transport
        share     = [PSCustomObject]@{
            centralPath = $CentralStorePath
        }
        graph     = [PSCustomObject]@{
            tenantId     = ""
            clientId     = ""
            clientSecret = ""
            driveId      = ""
            folderPath   = "VserveTimeChamp"
        }
        googleDrive = [PSCustomObject]@{
            serviceAccountKeyPath = ""
            folderId              = ""
        }
    }
}

$configPath = Join-Path $resolvedInstallDir "config.json"
$configJson = $configObj | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($configPath, $configJson, [System.Text.Encoding]::UTF8)
Write-Host "Created configuration at: $configPath"

# Register Auto-Start (No Admin Required)
$launcherPath  = Join-Path $resolvedInstallDir "launcher.vbs"
$agentPath     = Join-Path $resolvedInstallDir "agent.ps1"
$launchCommand = "wscript.exe `"$launcherPath`" `"$agentPath`""

$watchdogLauncher = Join-Path $resolvedInstallDir "launcher-watchdog.vbs"
$watchdogScript   = Join-Path $resolvedInstallDir "vserve-watchdog.ps1"
$watchdogCommand  = "wscript.exe `"$watchdogLauncher`" `"$watchdogScript`""

if ($Method -eq "RunKey") {
    $runKeyPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
    # Set VserveTimeChampAgent and backward-compatible WorkTimerAgent
    Set-ItemProperty -Path $runKeyPath -Name "VserveTimeChampAgent" -Value $launchCommand -Force
    Set-ItemProperty -Path $runKeyPath -Name "WorkTimerAgent" -Value $launchCommand -Force
    Set-ItemProperty -Path $runKeyPath -Name "VserveTimeChampWatchdog" -Value $watchdogCommand -Force
    Write-Host "Registered HKCU Run key: VserveTimeChampAgent -> $launchCommand"
    Write-Host "Registered HKCU Run key: WorkTimerAgent -> $launchCommand"
    Write-Host "Registered HKCU Run key: VserveTimeChampWatchdog -> $watchdogCommand"
}
elseif ($Method -eq "TaskScheduler") {
    $taskName = "VserveTimeChampAgent"
    & schtasks.exe /Create /TN $taskName /TR $launchCommand /SC ONLOGON /F | Out-Null
    & schtasks.exe /Create /TN "WorkTimerAgent" /TR $launchCommand /SC ONLOGON /F | Out-Null
    & schtasks.exe /Create /TN "VserveTimeChampWatchdog" /TR $watchdogCommand /SC ONLOGON /F | Out-Null
    Write-Host "Registered User Scheduled Tasks: VserveTimeChampAgent & VserveTimeChampWatchdog"
}

# Ensure CurrentUser execution policy allows local scripts
try {
    $currentEp = Get-ExecutionPolicy -Scope CurrentUser
    if ($currentEp -eq "Undefined" -or $currentEp -eq "Restricted") {
        Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force -ErrorAction SilentlyContinue
    }
} catch {}

# Start Agent & Watchdog
if ($StartNow) {
    # Stop existing instance first if any
    & "$resolvedInstallDir\agent.ps1" -Stop | Out-Null
    Start-Sleep -Milliseconds 500

    Write-Host "Starting Vserve-TimeChamp Agent silently..."
    Start-Process -FilePath "wscript.exe" -ArgumentList "`"$launcherPath`" `"$agentPath`""
    Start-Sleep -Seconds 1
    Write-Host "Vserve-TimeChamp Agent started."

    if (Test-Path $watchdogLauncher) {
        Write-Host "Starting Vserve-TimeChamp Watchdog silently..."
        Start-Process -FilePath "wscript.exe" -ArgumentList "`"$watchdogLauncher`" `"$watchdogScript`""
        Write-Host "Vserve-TimeChamp Watchdog started."
    }
}

Write-Host "=== Installation Complete ==="
Write-Host "Status check command: & `"$resolvedInstallDir\agent.ps1`" -Status"
