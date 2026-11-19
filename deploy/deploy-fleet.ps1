<#
.SYNOPSIS
    Work Timer - Fleet Deployment Script for IT Administrators (GPO / Intune / RMM)
.DESCRIPTION
    Standardized silent logon deployment script. Copies agent files from a central distribution
    share (or embedded payload) to %LOCALAPPDATA%\WT\, configures auto-start, and ensures the agent
    is running. Idempotent: safe to run on every user logon via GPO.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$DistributionShare = "\\server\distribution\WorkTimer",

    [Parameter(Mandatory = $false)]
    [string]$CentralStorePath = "\\server\worktime",

    [Parameter(Mandatory = $false)]
    [int]$IdleThresholdSeconds = 600,

    [Parameter(Mandatory = $false)]
    [int]$TickIntervalSeconds = 30,

    [Parameter(Mandatory = $false)]
    [int]$SyncIntervalSeconds = 900
)

$targetDir = "$env:LOCALAPPDATA\WT"

if (-not (Test-Path $targetDir)) {
    New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
}

# Determine source directory (from share if given and reachable, else local script folder)
$sourceDir = if (Test-Path $DistributionShare) {
    $DistributionShare
} else {
    $currDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
    if (Test-Path (Join-Path $currDir "..\agent\agent.ps1")) {
        (Resolve-Path (Join-Path $currDir "..\agent")).Path
    } else {
        $currDir
    }
}

# Copy files if newer or missing
$files = @("agent.ps1", "launcher.vbs", "run-agent.bat")
foreach ($f in $files) {
    $src = Join-Path $sourceDir $f
    $dst = Join-Path $targetDir $f
    if (Test-Path $src) {
        if (-not (Test-Path $dst) -or ((Get-Item $src).LastWriteTimeUtc -gt (Get-Item $dst).LastWriteTimeUtc)) {
            Copy-Item -Path $src -Destination $dst -Force
        }
    }
}

# Copy sync transport if present
$syncSrc = Join-Path (Join-Path $sourceDir "..\sync") "Sync-Transport.ps1"
if (-not (Test-Path $syncSrc)) { $syncSrc = Join-Path $sourceDir "Sync-Transport.ps1" }
if (Test-Path $syncSrc) {
    Copy-Item -Path $syncSrc -Destination $targetDir -Force
}

# Create / verify config.json
$cfgPath = Join-Path $targetDir "config.json"
if (-not (Test-Path $cfgPath)) {
    $configObj = [PSCustomObject]@{
        agent = [PSCustomObject]@{
            user                      = [System.Environment]::UserName
            machine                   = [System.Environment]::MachineName
            localDataPath             = "%LOCALAPPDATA%\WT"
            tickIntervalSeconds       = $TickIntervalSeconds
            idleThresholdSeconds      = $IdleThresholdSeconds
            stateFlushIntervalSeconds = $TickIntervalSeconds
            syncIntervalSeconds       = $SyncIntervalSeconds
            logLevel                  = "INFO"
            maxLogSizeBytes           = 5242880
            maxRotatedLogs            = 3
        }
        sync  = [PSCustomObject]@{
            transport = "Share"
            share     = [PSCustomObject]@{
                centralPath = $CentralStorePath
            }
        }
    }
    $json = $configObj | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText($cfgPath, $json, [System.Text.Encoding]::UTF8)
}

# Set HKCU Run key for user logon auto-start
$launcherPath = Join-Path $targetDir "launcher.vbs"
$agentPath    = Join-Path $targetDir "agent.ps1"
$launchCmd    = "wscript.exe `"$launcherPath`" `"$agentPath`""
$runKeyPath   = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
Set-ItemProperty -Path $runKeyPath -Name "WorkTimerAgent" -Value $launchCmd -Force

# Start agent if not currently running
$running = Get-CimInstance Win32_Process | Where-Object {
    $_.ProcessId -ne $PID -and
    $_.CommandLine -match 'agent\.ps1' -and
    $_.CommandLine -notmatch '-(Status|SingleTick|Stop)\b'
}

if (-not $running) {
    Start-Process -FilePath "wscript.exe" -ArgumentList "`"$launcherPath`" `"$agentPath`""
}
