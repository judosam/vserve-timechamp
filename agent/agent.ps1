<#
.SYNOPSIS
    Vserve-TimeChamp - Lightweight Silent Background Work Timer & Productivity Agent
.DESCRIPTION
    Replicates TimeChamp enterprise tracking capabilities without admin rights:
    - Active session & idle time monitoring via Win32 GetLastInputInfo
    - Foreground application and active window title tracking
    - Browser URL and domain inspection via Windows UI Automation (Chrome, Edge, Brave)
    - Productivity classification (Productive, Unproductive, Neutral)
    - Optional multi-monitor screenshot auditing with privacy blur
    - Monotonic state persistence to %LOCALAPPDATA%\VserveTimeChamp\
    - Background sync to central store (LAN share, OneDrive/SharePoint, Google Drive)
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$ConfigPath,

    [Parameter(Mandatory = $false)]
    [switch]$SingleTick,

    [Parameter(Mandatory = $false)]
    [switch]$Stop,

    [Parameter(Mandatory = $false)]
    [switch]$Status,

    [Parameter(Mandatory = $false)]
    [switch]$ShowTodaySummary,

    [Parameter(Mandatory = $false)]
    [switch]$SyncNow,

    [Parameter(Mandatory = $false)]
    [int]$MockIdleSeconds = -1,

    [Parameter(Mandatory = $false)]
    [string]$MockDate,

    [Parameter(Mandatory = $false)]
    [int]$TickInterval,

    [Parameter(Mandatory = $false)]
    [int]$IdleThreshold,

    [Parameter(Mandatory = $false)]
    [string]$LocalDataPath,

    [Parameter(Mandatory = $false)]
    [string]$CentralPath,

    [Parameter(Mandatory = $false)]
    [switch]$VerboseLog
)

# -------------------------------------------------------------------------
# Win32 Idle Detector P/Invoke Definition
# -------------------------------------------------------------------------
if (-not ([System.Management.Automation.PSTypeName]'WorkTimer.Win32.IdleDetector').Type) {
    Add-Type @'
using System;
using System.Runtime.InteropServices;

namespace WorkTimer.Win32 {
    public static class IdleDetector {
        [StructLayout(LayoutKind.Sequential)]
        public struct LASTINPUTINFO {
            public uint cbSize;
            public uint dwTime;
        }

        [DllImport("user32.dll")]
        public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

        public static uint CalculateIdleSeconds(uint currentTick, uint lastInputTick) {
            return unchecked(currentTick - lastInputTick) / 1000;
        }

        public static uint GetIdleSeconds() {
            LASTINPUTINFO lii = new LASTINPUTINFO();
            lii.cbSize = (uint)Marshal.SizeOf(lii);
            if (!GetLastInputInfo(ref lii)) return 0;
            uint currentTick = unchecked((uint)Environment.TickCount);
            return CalculateIdleSeconds(currentTick, lii.dwTime);
        }
    }
}
'@
}

# -------------------------------------------------------------------------
# Helper Functions
# -------------------------------------------------------------------------
function Format-DurationHMS([int64]$sec) {
    if ($sec -lt 0) { $sec = 0 }
    $h = [math]::Floor($sec / 3600)
    $m = [math]::Floor(($sec % 3600) / 60)
    $s = $sec % 60
    return ("{0:D2}:{1:D2}:{2:D2}" -f [int]$h, [int]$m, [int]$s)
}

function Load-AgentConfig([string]$explicitPath, [string]$scriptDir) {
    $searchPaths = @()
    if (-not [string]::IsNullOrEmpty($explicitPath)) {
        $searchPaths += $explicitPath
    }
    $searchPaths += (Join-Path $scriptDir "config.json")
    $searchPaths += (Join-Path $scriptDir "config.default.json")
    $searchPaths += (Join-Path (Join-Path $env:LOCALAPPDATA "VserveTimeChamp") "config.json")
    $searchPaths += (Join-Path (Join-Path $env:LOCALAPPDATA "WT") "config.json")
    $searchPaths += (Join-Path (Split-Path $scriptDir -Parent) "config.default.json")

    $foundPath = $null
    foreach ($p in $searchPaths) {
        if (Test-Path $p) {
            $foundPath = $p
            break
        }
    }

    if ($foundPath) {
        try {
            $raw = Get-Content -Path $foundPath -Raw -ErrorAction Stop
            return ($raw | ConvertFrom-Json)
        }
        catch {
            Write-Warning "Failed to parse configuration file ${foundPath} - $($_.Exception.Message)"
        }
    }

    # Fallback in-memory defaults
    return [PSCustomObject]@{
        project = "vserve-timechamp"
        version = "1.2.0"
        agent = [PSCustomObject]@{
            user = ""
            machine = ""
            localDataPath = "%LOCALAPPDATA%\VserveTimeChamp"
            tickIntervalSeconds = 30
            idleThresholdSeconds = 600
            stateFlushIntervalSeconds = 30
            syncIntervalSeconds = 900
            logLevel = "INFO"
            maxLogSizeBytes = 5242880
            maxRotatedLogs = 3
            enableAppTracking = $true
            enableBrowserUrlTracking = $true
            enableScreenshots = $false
            screenshotIntervalSeconds = 600
            screenshotBlur = $false
        }
        productivityRules = [PSCustomObject]@{
            productiveApps = @("code.exe", "devenv.exe", "idea64.exe", "excel.exe", "winword.exe", "powerpnt.exe", "teams.exe", "slack.exe", "outlook.exe", "antigravity.exe", "powershell.exe", "cmd.exe")
            unproductiveApps = @("spotify.exe", "steam.exe", "epicgameslauncher.exe", "discord.exe")
            productiveUrls = @("github.com", "gitlab.com", "bitbucket.org", "stackoverflow.com", "learn.microsoft.com", "docs.google.com", "jira", "confluence", "vservesolution.com")
            unproductiveUrls = @("facebook.com", "instagram.com", "twitter.com", "x.com", "tiktok.com", "netflix.com", "reddit.com")
        }
        sync = [PSCustomObject]@{
            transport = "Share"
            share = [PSCustomObject]@{
                centralPath = "\\server\worktime"
            }
        }
    }
}

# -------------------------------------------------------------------------
# Setup Paths & Environment
# -------------------------------------------------------------------------
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
if ([string]::IsNullOrEmpty($scriptDir)) { $scriptDir = (Get-Location).Path }

$config = Load-AgentConfig -explicitPath $ConfigPath -scriptDir $scriptDir

# Overrides from parameters
if ($TickInterval -gt 0) { $config.agent.tickIntervalSeconds = $TickInterval }
if ($IdleThreshold -gt 0) { $config.agent.idleThresholdSeconds = $IdleThreshold }
if (-not [string]::IsNullOrEmpty($LocalDataPath)) { $config.agent.localDataPath = $LocalDataPath }
if (-not [string]::IsNullOrEmpty($CentralPath)) {
    if (-not $config.sync.share) { $config.sync | Add-Member -MemberType NoteProperty -Name share -Value ([PSCustomObject]@{}) }
    $config.sync.share.centralPath = $CentralPath
}
if ($VerboseLog) { $config.agent.logLevel = "DEBUG" }

# Resolve User and Machine
$user = if (-not [string]::IsNullOrWhiteSpace($config.agent.user)) { $config.agent.user } else { [System.Environment]::UserName }
$machine = if (-not [string]::IsNullOrWhiteSpace($config.agent.machine)) { $config.agent.machine } else { [System.Environment]::MachineName }

# Resolve local data directory
$rawLocalPath = if (-not [string]::IsNullOrWhiteSpace($config.agent.localDataPath)) { $config.agent.localDataPath } else { "%LOCALAPPDATA%\VserveTimeChamp" }
$resolvedLocalPath = [System.Environment]::ExpandEnvironmentVariables($rawLocalPath)
if (-not (Test-Path $resolvedLocalPath)) {
    New-Item -ItemType Directory -Path $resolvedLocalPath -Force | Out-Null
}

$logFilePath = Join-Path $resolvedLocalPath "agent.log"

# -------------------------------------------------------------------------
# Logging with Rotation
# -------------------------------------------------------------------------
$script:LogFile = $logFilePath
$script:LogLevel = if ($config.agent.logLevel) { $config.agent.logLevel.ToUpper() } else { "INFO" }
$script:MaxLogSize = if ($config.agent.maxLogSizeBytes) { [int64]$config.agent.maxLogSizeBytes } else { 5242880 }
$script:MaxRotated = if ($config.agent.maxRotatedLogs) { [int]$config.agent.maxRotatedLogs } else { 3 }

function Write-AgentLog {
    param(
        [Parameter(Mandatory = $true)][string]$Level,
        [Parameter(Mandatory = $true)][string]$Message
    )

    $levels = @{ "DEBUG" = 0; "INFO" = 1; "WARN" = 2; "ERROR" = 3 }
    $currentVal = if ($levels.ContainsKey($script:LogLevel)) { $levels[$script:LogLevel] } else { 1 }
    $msgVal = if ($levels.ContainsKey($Level.ToUpper())) { $levels[$Level.ToUpper()] } else { 1 }

    if ($msgVal -lt $currentVal) { return }

    $timestamp = [DateTime]::UtcNow.ToString("yyyy-MM-dd HH:mm:ss.fffZ")
    $logLine = "[$timestamp] [$Level] $Message"

    try {
        if (Test-Path $script:LogFile) {
            $fi = Get-Item $script:LogFile
            if ($fi.Length -ge $script:MaxLogSize) {
                for ($r = $script:MaxRotated - 1; $r -ge 1; $r--) {
                    $old = "$($script:LogFile).$r"
                    $new = "$($script:LogFile).$($r + 1)"
                    if (Test-Path $old) { Move-Item -Path $old -Destination $new -Force -ErrorAction SilentlyContinue }
                }
                Move-Item -Path $script:LogFile -Destination "$($script:LogFile).1" -Force -ErrorAction SilentlyContinue
            }
        }
        [System.IO.File]::AppendAllText($script:LogFile, "$logLine`r`n", [System.Text.Encoding]::UTF8)
    }
    catch {}
}

# -------------------------------------------------------------------------
# Load Activity Tracking Module
# -------------------------------------------------------------------------
$activityModulePath = Join-Path $scriptDir "Vserve-ActivityTracker.ps1"
if (Test-Path $activityModulePath) {
    . $activityModulePath
} else {
    Write-AgentLog "WARN" "Activity tracker module not found at $activityModulePath"
}

# -------------------------------------------------------------------------
# Handle -Stop, -Status, and -ShowTodaySummary CLI flags
# -------------------------------------------------------------------------
if ($Stop) {
    Write-Host "Stopping Vserve-TimeChamp agent processes for user '$user'..."
    $currentPid = $PID
    $stopped = 0
    try {
        $processes = Get-CimInstance Win32_Process | Where-Object {
            $_.ProcessId -ne $currentPid -and
            ($_.CommandLine -match 'agent\.ps1' -or $_.CommandLine -match 'launcher\.vbs')
        }
        foreach ($proc in $processes) {
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
            $stopped++
            Write-Host "Stopped process ID $($proc.ProcessId)"
        }
    }
    catch {
        Write-Warning "Error stopping processes: $($_.Exception.Message)"
    }
    Write-Host "Vserve-TimeChamp stopped ($stopped process(es) terminated)."
    return
}

if ($Status -or $ShowTodaySummary) {
    Write-Host "=========================================================="
    Write-Host "             Vserve-TimeChamp Status & Summary            "
    Write-Host "=========================================================="
    Write-Host "User:             $user"
    Write-Host "Machine:          $machine"
    Write-Host "Local Directory:  $resolvedLocalPath"

    $todayDate = if (-not [string]::IsNullOrEmpty($MockDate)) { $MockDate } else { [DateTime]::Now.ToString("yyyy-MM-dd") }
    $todayStateFile = Join-Path $resolvedLocalPath "state_$todayDate.json"
    $activitiesFile = Join-Path $resolvedLocalPath "activities_$todayDate.json"

    if (Test-Path $todayStateFile) {
        $stateJson = Get-Content -Path $todayStateFile -Raw | ConvertFrom-Json
        $prodPct = 0
        if ($stateJson.active_seconds -gt 0) {
            $prodPct = [math]::Round((([int64]$stateJson.productive_seconds) / ([int64]$stateJson.active_seconds)) * 100, 1)
        }

        Write-Host "`n--- Shift Totals for $todayDate ---"
        Write-Host "Status:           $($stateJson.status)"
        Write-Host "Active Time:      $(Format-DurationHMS $stateJson.active_seconds) ($($stateJson.active_seconds)s)"
        Write-Host "Idle Time:        $(Format-DurationHMS $stateJson.idle_seconds) ($($stateJson.idle_seconds)s)"
        Write-Host "Pauses Count:     $($stateJson.pause_count)"
        Write-Host "Productive Time:  $(Format-DurationHMS $stateJson.productive_seconds) (${prodPct}%)"
        Write-Host "Unproductive:     $(Format-DurationHMS $stateJson.unproductive_seconds)"
        Write-Host "First Input:      $($stateJson.first_input_utc)"
        Write-Host "Last Input:       $($stateJson.last_input_utc)"
        Write-Host "Last State Flush: $($stateJson.last_flush_utc)"
    } else {
        Write-Host "No active state file found for today ($todayDate)."
    }

    if (Test-Path $activitiesFile) {
        try {
            $actJson = Get-Content -Path $activitiesFile -Raw | ConvertFrom-Json
            Write-Host "`n--- Top Applications ---"
            if ($actJson.applications) {
                $apps = $actJson.applications.PSObject.Properties | Sort-Object { [int64]$_.Value.seconds } -Descending | Select-Object -First 5
                foreach ($app in $apps) {
                    Write-Host ("  {0,-22} {1,10} ({2})" -f $app.Name, (Format-DurationHMS $app.Value.seconds), $app.Value.classification)
                }
            }

            Write-Host "`n--- Top Websites ---"
            if ($actJson.websites) {
                $webs = $actJson.websites.PSObject.Properties | Sort-Object { [int64]$_.Value.seconds } -Descending | Select-Object -First 5
                foreach ($web in $webs) {
                    Write-Host ("  {0,-25} {1,10} ({2})" -f $web.Name, (Format-DurationHMS $web.Value.seconds), $web.Value.classification)
                }
            }
        } catch {}
    }

    # Check running processes
    $runningAgent = Get-CimInstance Win32_Process | Where-Object {
        $_.ProcessId -ne $PID -and
        $_.CommandLine -match 'agent\.ps1' -and
        $_.CommandLine -notmatch '-(Status|SingleTick|Stop|ShowTodaySummary)\b'
    }
    $runningWatchdog = Get-CimInstance Win32_Process | Where-Object {
        $_.ProcessId -ne $PID -and
        $_.CommandLine -match 'vserve-watchdog\.ps1'
    }

    Write-Host "`n--- Service Health ---"
    Write-Host ("Agent Process:    {0}" -f $(if ($runningAgent) { "RUNNING (PID: " + (($runningAgent | Select-Object -ExpandProperty ProcessId) -join ', ') + ")" } else { "NOT RUNNING" }))
    Write-Host ("Watchdog Process: {0}" -f $(if ($runningWatchdog) { "RUNNING (PID: " + (($runningWatchdog | Select-Object -ExpandProperty ProcessId) -join ', ') + ")" } else { "NOT RUNNING" }))
    Write-Host "=========================================================="
    return
}

# -------------------------------------------------------------------------
# Load Sync Module
# -------------------------------------------------------------------------
$syncModulePath = Join-Path (Join-Path $scriptDir "..") "sync\Sync-Transport.ps1"
if (-not (Test-Path $syncModulePath)) {
    $syncModulePath = Join-Path $scriptDir "Sync-Transport.ps1"
}
if (Test-Path $syncModulePath) {
    . $syncModulePath
} else {
    Write-AgentLog "WARN" "Sync transport module not found at $syncModulePath"
}

# -------------------------------------------------------------------------
# Handle -SyncNow CLI flag
# -------------------------------------------------------------------------
if ($SyncNow) {
    Write-Host "Executing immediate sync for user '$user'..."
    $todayDate = if (-not [string]::IsNullOrEmpty($MockDate)) { $MockDate } else { [DateTime]::Now.ToString("yyyy-MM-dd") }
    $todayCsv = Join-Path $resolvedLocalPath "daily_$todayDate.csv"
    if (Test-Path $todayCsv) {
        $loggerSb = { param($lvl, $msg) Write-AgentLog $lvl $msg; Write-Host "[$lvl] $msg" }
        $success = Invoke-SyncTransport -LocalFilePath $todayCsv -User $user -Date $todayDate -Config $config -Logger $loggerSb
        if ($success) { Write-Host "Sync completed successfully." }
        else { Write-Host "Sync failed. Check agent.log for details." }
    } else {
        Write-Host "No CSV found to sync at $todayCsv"
    }
    return
}

# -------------------------------------------------------------------------
# Single-Instance Enforcement
# -------------------------------------------------------------------------
$mutexName = "Local\VserveTimeChampAgent_$user"
$createdNew = $false
$agentMutex = $null
if (-not $SingleTick) {
    try {
        $agentMutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$createdNew)
        if (-not $createdNew) {
            Write-AgentLog "WARN" "Agent already running for user '$user'. Exiting duplicate instance."
            return
        }
    }
    catch {
        Write-AgentLog "WARN" "Mutex error: $($_.Exception.Message)"
    }
}

# -------------------------------------------------------------------------
# State Management & Persistence Functions
# -------------------------------------------------------------------------
function Get-CurrentDateString {
    if (-not [string]::IsNullOrEmpty($MockDate)) { return $MockDate }
    return [DateTime]::Now.ToString("yyyy-MM-dd")
}

function Save-AgentStateAtomic {
    param(
        [Parameter(Mandatory = $true)][hashtable]$State,
        [Parameter(Mandatory = $true)][string]$Dir
    )

    $dateStr = $State["date"]
    $stateFilePath = Join-Path $Dir "state_$dateStr.json"
    $tmpFilePath = Join-Path $Dir "state_$dateStr.json.tmp"

    try {
        $json = $State | ConvertTo-Json -Depth 6
        [System.IO.File]::WriteAllText($tmpFilePath, $json, [System.Text.Encoding]::UTF8)
        Move-Item -Path $tmpFilePath -Destination $stateFilePath -Force
    }
    catch {
        Write-AgentLog "ERROR" "Failed to save state atomically: $($_.Exception.Message)"
    }
}

function Save-DailyCsv {
    param(
        [Parameter(Mandatory = $true)][hashtable]$State,
        [Parameter(Mandatory = $true)][string]$Dir
    )

    $dateStr = $State["date"]
    $csvPath = Join-Path $Dir "daily_$dateStr.csv"
    $csvNamedPath = Join-Path $Dir "daily_$($State['user'])_$dateStr.csv"

    $activeSec = [int64]$State["active_seconds"]
    $idleSec = [int64]$State["idle_seconds"]
    $activeHms = Format-DurationHMS $activeSec
    $idleHms = Format-DurationHMS $idleSec

    $prodSec = [int64]$State["productive_seconds"]
    $unprodSec = [int64]$State["unproductive_seconds"]
    $prodPct = if ($activeSec -gt 0) { [math]::Round(($prodSec / $activeSec) * 100, 1) } else { 0 }

    $csvHeader = "date,user,machine,active_seconds,active_hms,idle_seconds,idle_hms,first_input_utc,last_input_utc,pause_count,productive_seconds,unproductive_seconds,productivity_pct"
    $csvRow = "$($State['date']),$($State['user']),$($State['machine']),$activeSec,$activeHms,$idleSec,$idleHms,$($State['first_input_utc']),$($State['last_input_utc']),$($State['pause_count']),$prodSec,$unprodSec,$prodPct"

    try {
        $content = "$csvHeader`r`n$csvRow`r`n"
        [System.IO.File]::WriteAllText($csvPath, $content, [System.Text.Encoding]::UTF8)
        [System.IO.File]::WriteAllText($csvNamedPath, $content, [System.Text.Encoding]::UTF8)
    }
    catch {
        Write-AgentLog "ERROR" "Failed to write daily CSV: $($_.Exception.Message)"
    }
}

function Save-ActivitiesData {
    param(
        [Parameter(Mandatory = $true)][hashtable]$Activities,
        [Parameter(Mandatory = $true)][string]$DateStr,
        [Parameter(Mandatory = $true)][string]$User,
        [Parameter(Mandatory = $true)][string]$Dir
    )

    $jsonPath = Join-Path $Dir "activities_$DateStr.json"
    $csvPath = Join-Path $Dir "activities_$DateStr.csv"
    $csvNamedPath = Join-Path $Dir "activities_${User}_$DateStr.csv"

    try {
        $json = $Activities | ConvertTo-Json -Depth 6
        [System.IO.File]::WriteAllText($jsonPath, $json, [System.Text.Encoding]::UTF8)

        # Export flattened CSV for easy admin analytics
        $lines = @("date,user,type,target,duration_seconds,duration_hms,classification")
        if ($Activities.ContainsKey("applications")) {
            foreach ($app in $Activities["applications"].Keys) {
                $item = $Activities["applications"][$app]
                $lines += "$DateStr,$User,App,$app,$($item['seconds']),$(Format-DurationHMS $item['seconds']),$($item['classification'])"
            }
        }
        if ($Activities.ContainsKey("websites")) {
            foreach ($web in $Activities["websites"].Keys) {
                $item = $Activities["websites"][$web]
                $lines += "$DateStr,$User,Website,$web,$($item['seconds']),$(Format-DurationHMS $item['seconds']),$($item['classification'])"
            }
        }
        $csvText = ($lines -join "`r`n") + "`r`n"
        [System.IO.File]::WriteAllText($csvPath, $csvText, [System.Text.Encoding]::UTF8)
        [System.IO.File]::WriteAllText($csvNamedPath, $csvText, [System.Text.Encoding]::UTF8)
    }
    catch {
        Write-AgentLog "ERROR" "Failed to save activities data: $($_.Exception.Message)"
    }
}

function Load-OrInitActivities {
    param([string]$DateStr, [string]$Dir)
    $jsonPath = Join-Path $Dir "activities_$DateStr.json"
    if (Test-Path $jsonPath) {
        try {
            $raw = Get-Content -Path $jsonPath -Raw -ErrorAction Stop
            $loaded = $raw | ConvertFrom-Json
            $map = @{
                "applications" = @{}
                "websites"     = @{}
            }
            if ($loaded.applications) {
                foreach ($prop in $loaded.applications.PSObject.Properties) {
                    $map["applications"][$prop.Name] = @{
                        "seconds" = [int64]$prop.Value.seconds
                        "classification" = [string]$prop.Value.classification
                    }
                }
            }
            if ($loaded.websites) {
                foreach ($prop in $loaded.websites.PSObject.Properties) {
                    $map["websites"][$prop.Name] = @{
                        "seconds" = [int64]$prop.Value.seconds
                        "classification" = [string]$prop.Value.classification
                    }
                }
            }
            return $map
        } catch {}
    }
    return @{
        "applications" = @{}
        "websites"     = @{}
    }
}

function Load-OrInitDayState {
    param(
        [string]$DateStr,
        [string]$User,
        [string]$Machine,
        [string]$Dir
    )

    $stateFilePath = Join-Path $Dir "state_$DateStr.json"
    if (Test-Path $stateFilePath) {
        try {
            $raw = Get-Content -Path $stateFilePath -Raw -ErrorAction Stop
            $loaded = $raw | ConvertFrom-Json
            Write-AgentLog "INFO" "Resumed state for $DateStr. Active: $($loaded.active_seconds)s, Idle: $($loaded.idle_seconds)s, Pauses: $($loaded.pause_count)"
            return @{
                "user"                 = $User
                "machine"              = $Machine
                "date"                 = $DateStr
                "active_seconds"       = [int64]$loaded.active_seconds
                "idle_seconds"         = [int64]$loaded.idle_seconds
                "productive_seconds"   = if ($loaded.productive_seconds) { [int64]$loaded.productive_seconds } else { 0 }
                "unproductive_seconds" = if ($loaded.unproductive_seconds) { [int64]$loaded.unproductive_seconds } else { 0 }
                "neutral_seconds"      = if ($loaded.neutral_seconds) { [int64]$loaded.neutral_seconds } else { 0 }
                "status"               = if ($loaded.status) { [string]$loaded.status } else { "active" }
                "pause_count"          = [int]$loaded.pause_count
                "first_input_utc"      = [string]$loaded.first_input_utc
                "last_input_utc"       = [string]$loaded.last_input_utc
                "last_flush_utc"       = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
                "day_start_utc"        = if ($loaded.day_start_utc) { [string]$loaded.day_start_utc } else { [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ") }
            }
        }
        catch {
            Write-AgentLog "WARN" "Corrupted state file encountered. Initializing fresh day state: $($_.Exception.Message)"
        }
    }

    $nowUtc = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
    Write-AgentLog "INFO" "Initialized new day state for $DateStr ($User on $Machine)"
    return @{
        "user"                 = $User
        "machine"              = $Machine
        "date"                 = $DateStr
        "active_seconds"       = [int64]0
        "idle_seconds"         = [int64]0
        "productive_seconds"   = [int64]0
        "unproductive_seconds" = [int64]0
        "neutral_seconds"      = [int64]0
        "status"               = "active"
        "pause_count"          = 0
        "first_input_utc"      = ""
        "last_input_utc"       = ""
        "last_flush_utc"       = $nowUtc
        "day_start_utc"        = $nowUtc
    }
}

# -------------------------------------------------------------------------
# Agent Execution Loop
# -------------------------------------------------------------------------
$tickIntervalSec = [int]$config.agent.tickIntervalSeconds
if ($tickIntervalSec -le 0) { $tickIntervalSec = 30 }

$idleThresholdSec = [int]$config.agent.idleThresholdSeconds
if ($idleThresholdSec -le 0) { $idleThresholdSec = 600 }

$syncIntervalSec = [int]$config.agent.syncIntervalSeconds
if ($syncIntervalSec -le 0) { $syncIntervalSec = 900 }

$enableAppTracking = if ($config.agent.enableAppTracking -ne $false) { $true } else { $false }
$enableBrowserTracking = if ($config.agent.enableBrowserUrlTracking -ne $false) { $true } else { $false }
$enableScreenshots = if ($config.agent.enableScreenshots -eq $true) { $true } else { $false }
$screenshotIntervalSec = if ($config.agent.screenshotIntervalSeconds -gt 0) { [int]$config.agent.screenshotIntervalSeconds } else { 600 }
$screenshotBlur = if ($config.agent.screenshotBlur -eq $true) { $true } else { $false }

$currentDate = Get-CurrentDateString
$state = Load-OrInitDayState -DateStr $currentDate -User $user -Machine $machine -Dir $resolvedLocalPath
$activities = Load-OrInitActivities -DateStr $currentDate -Dir $resolvedLocalPath

$lastTickTime = [DateTime]::UtcNow
$lastSyncTime = [DateTime]::UtcNow
$lastScreenshotTime = [DateTime]::UtcNow

Write-AgentLog "INFO" "Vserve-TimeChamp Agent started. User: $user, Machine: $machine, Tick: ${tickIntervalSec}s, IdleThreshold: ${idleThresholdSec}s, AppTracking: $enableAppTracking, LocalDir: $resolvedLocalPath"

function Perform-Tick {
    param([ref]$StateRef, [ref]$CurrentDateRef, [ref]$LastTickTimeRef, [ref]$LastSyncTimeRef, [ref]$ActivitiesRef, [ref]$LastScreenshotTimeRef)

    $now = [DateTime]::UtcNow
    $todayStr = Get-CurrentDateString

    # 1. Midnight Rollover Check
    if ($todayStr -ne $CurrentDateRef.Value) {
        Write-AgentLog "INFO" "Midnight rollover detected: rolling from $($CurrentDateRef.Value) to $todayStr"

        # Finalize and sync yesterday
        $StateRef.Value["last_flush_utc"] = $now.ToString("yyyy-MM-ddTHH:mm:ssZ")
        Save-AgentStateAtomic -State $StateRef.Value -Dir $resolvedLocalPath
        Save-DailyCsv -State $StateRef.Value -Dir $resolvedLocalPath
        Save-ActivitiesData -Activities $ActivitiesRef.Value -DateStr $CurrentDateRef.Value -User $user -Dir $resolvedLocalPath

        $yesterdayCsv = Join-Path $resolvedLocalPath "daily_$($CurrentDateRef.Value).csv"
        $loggerSb = { param($lvl, $msg) Write-AgentLog $lvl $msg }
        Invoke-SyncTransport -LocalFilePath $yesterdayCsv -User $user -Date $CurrentDateRef.Value -Config $config -Logger $loggerSb | Out-Null

        # Also sync activities CSV if exists
        $yesterdayActCsv = Join-Path $resolvedLocalPath "activities_$($CurrentDateRef.Value).csv"
        if (Test-Path $yesterdayActCsv) {
            Invoke-SyncTransport -LocalFilePath $yesterdayActCsv -User $user -Date $CurrentDateRef.Value -Config $config -Logger $loggerSb | Out-Null
        }

        # Initialize fresh state for new day
        $CurrentDateRef.Value = $todayStr
        $StateRef.Value = Load-OrInitDayState -DateStr $todayStr -User $user -Machine $machine -Dir $resolvedLocalPath
        $ActivitiesRef.Value = Load-OrInitActivities -DateStr $todayStr -Dir $resolvedLocalPath
    }

    # 2. Elapsed time since last tick
    $elapsedSec = ($now - $LastTickTimeRef.Value).TotalSeconds
    $LastTickTimeRef.Value = $now

    $interval = if ($SingleTick -or $elapsedSec -le 1) {
        $tickIntervalSec
    } elseif ($elapsedSec -gt ($tickIntervalSec * 2)) {
        Write-AgentLog "INFO" "System resume or time jump detected ($([math]::Round($elapsedSec))s elapsed). Capping active interval to $tickIntervalSec s."
        $tickIntervalSec
    } else {
        [int][math]::Round($elapsedSec)
    }

    # 3. Query Win32 Idle time
    $currentIdleSec = if ($MockIdleSeconds -ge 0) {
        [uint32]$MockIdleSeconds
    } else {
        [WorkTimer.Win32.IdleDetector]::GetIdleSeconds()
    }

    # 4. Active vs Idle determination
    if ($currentIdleSec -lt $idleThresholdSec) {
        # Active
        if ($StateRef.Value["status"] -eq "idle") {
            Write-AgentLog "INFO" "User resumed activity (idle was ${currentIdleSec}s)."
            $StateRef.Value["status"] = "active"
        }

        $StateRef.Value["active_seconds"] += $interval

        # Record input timestamps
        $inputUtc = $now.AddSeconds(-$currentIdleSec).ToString("yyyy-MM-ddTHH:mm:ssZ")
        $StateRef.Value["last_input_utc"] = $inputUtc
        if ([string]::IsNullOrEmpty($StateRef.Value["first_input_utc"])) {
            $StateRef.Value["first_input_utc"] = $inputUtc
        }

        # 4a. Application and Browser URL Inspection (TimeChamp Replicated Engine)
        if ($enableAppTracking -and -not $SingleTick) {
            try {
                $win = Get-ActiveWindowSnapshot
                $pName = $win.ProcessName
                $url = ""
                $domain = ""

                if ($enableBrowserTracking -and $win.Handle -ne [IntPtr]::Zero) {
                    $url = Get-ActiveBrowserUrl -ProcessName $pName -Hwnd $win.Handle
                    if ($url) {
                        $domain = Get-DomainFromUrl -Url $url
                    }
                }

                $classification = Get-ProductivityScore -ProcessName $pName -Url $url -Rules $config.productivityRules

                # Update Productivity Counters
                switch ($classification) {
                    "Productive"   { $StateRef.Value["productive_seconds"] += $interval }
                    "Unproductive" { $StateRef.Value["unproductive_seconds"] += $interval }
                    default        { $StateRef.Value["neutral_seconds"] += $interval }
                }

                # Update Application Aggregates
                if (-not [string]::IsNullOrEmpty($pName) -and $pName -ne "unknown") {
                    if (-not $ActivitiesRef.Value["applications"].ContainsKey($pName)) {
                        $ActivitiesRef.Value["applications"][$pName] = @{
                            "seconds" = [int64]0
                            "classification" = $classification
                        }
                    }
                    $ActivitiesRef.Value["applications"][$pName]["seconds"] += $interval
                }

                # Update Website Aggregates
                if (-not [string]::IsNullOrEmpty($domain)) {
                    if (-not $ActivitiesRef.Value["websites"].ContainsKey($domain)) {
                        $ActivitiesRef.Value["websites"][$domain] = @{
                            "seconds" = [int64]0
                            "classification" = $classification
                        }
                    }
                    $ActivitiesRef.Value["websites"][$domain]["seconds"] += $interval
                }
            } catch {
                Write-AgentLog "DEBUG" "App tracking error: $($_.Exception.Message)"
            }
        }
    }
    else {
        # Idle / Paused
        if ($StateRef.Value["status"] -eq "active") {
            $StateRef.Value["pause_count"]++
            $StateRef.Value["status"] = "idle"
            Write-AgentLog "INFO" "Idle threshold reached (${currentIdleSec}s >= ${idleThresholdSec}s). Timer paused (Pause #${($StateRef.Value['pause_count'])})."
        }

        $StateRef.Value["idle_seconds"] += $interval
    }

    # 5. Flush state and activities to disk atomically
    $StateRef.Value["last_flush_utc"] = $now.ToString("yyyy-MM-ddTHH:mm:ssZ")
    Save-AgentStateAtomic -State $StateRef.Value -Dir $resolvedLocalPath
    Save-DailyCsv -State $StateRef.Value -Dir $resolvedLocalPath

    if ($enableAppTracking) {
        Save-ActivitiesData -Activities $ActivitiesRef.Value -DateStr $CurrentDateRef.Value -User $user -Dir $resolvedLocalPath
    }

    # 6. Periodic Screenshots (if enabled)
    if ($enableScreenshots -and ($StateRef.Value["status"] -eq "active") -and -not $SingleTick) {
        $sinceScreenshot = ($now - $LastScreenshotTimeRef.Value).TotalSeconds
        if ($sinceScreenshot -ge $screenshotIntervalSec) {
            $LastScreenshotTimeRef.Value = $now
            $ssDir = Join-Path (Join-Path $resolvedLocalPath "screenshots") $CurrentDateRef.Value
            $ssFile = Join-Path $ssDir "ss_$($now.ToString('HHmmss')).jpg"
            Take-DesktopScreenshot -DestinationPath $ssFile -ApplyBlur:$screenshotBlur | Out-Null
            Write-AgentLog "DEBUG" "Periodic screenshot taken: $ssFile"
        }
    }

    # 7. Periodic Sync
    $sinceLastSync = ($now - $LastSyncTimeRef.Value).TotalSeconds
    if ($sinceLastSync -ge $syncIntervalSec) {
        $LastSyncTimeRef.Value = $now
        $dailyCsv = Join-Path $resolvedLocalPath "daily_$($CurrentDateRef.Value).csv"
        $loggerSb = { param($lvl, $msg) Write-AgentLog $lvl $msg }
        Invoke-SyncTransport -LocalFilePath $dailyCsv -User $user -Date $CurrentDateRef.Value -Config $config -Logger $loggerSb | Out-Null

        $actCsv = Join-Path $resolvedLocalPath "activities_$($CurrentDateRef.Value).csv"
        if (Test-Path $actCsv) {
            Invoke-SyncTransport -LocalFilePath $actCsv -User $user -Date $CurrentDateRef.Value -Config $config -Logger $loggerSb | Out-Null
        }
    }

    # 8. Live Heartbeat to Dashboard Server (Replicates TimeChamp Real-Time Heartbeat)
    if (-not $SingleTick) {
        try {
            $hbPayload = [PSCustomObject]@{
                user                = $user
                machine             = $machine
                status              = $StateRef.Value["status"]
                activeSeconds       = [int64]$StateRef.Value["active_seconds"]
                idleSeconds         = [int64]$StateRef.Value["idle_seconds"]
                productiveSeconds   = [int64]$StateRef.Value["productive_seconds"]
                unproductiveSeconds = [int64]$StateRef.Value["unproductive_seconds"]
                prodPct             = if ($StateRef.Value["active_seconds"] -gt 0) { [math]::Round(([int64]$StateRef.Value["productive_seconds"] / [int64]$StateRef.Value["active_seconds"]) * 100, 1) } else { 0 }
                currentApp          = if ($pName) { $pName } else { "None" }
                windowTitle         = if ($win -and $win.WindowTitle) { $win.WindowTitle } else { "System" }
                url                 = if ($url) { $url } else { "" }
                timestamp           = $now.ToString("yyyy-MM-ddTHH:mm:ssZ")
            } | ConvertTo-Json -Compress

            $hbUrl = if ($config.agent.heartbeatUrl) { $config.agent.heartbeatUrl } else { "http://localhost:3000/api/heartbeat" }
            $req = [System.Net.WebRequest]::Create($hbUrl)
            $req.Method = "POST"
            $req.ContentType = "application/json"
            $req.Timeout = 500
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($hbPayload)
            $req.ContentLength = $bytes.Length
            $stream = $req.GetRequestStream()
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Close()
            $resp = $req.GetResponse()
            $resp.Close()
        } catch {}
    }
}

# -------------------------------------------------------------------------
# Run Single Tick (Testing / Dry-run) OR Main Background Loop
# -------------------------------------------------------------------------
if ($SingleTick) {
    Perform-Tick -StateRef ([ref]$state) -CurrentDateRef ([ref]$currentDate) -LastTickTimeRef ([ref]$lastTickTime) -LastSyncTimeRef ([ref]$lastSyncTime) -ActivitiesRef ([ref]$activities) -LastScreenshotTimeRef ([ref]$lastScreenshotTime)
    Write-AgentLog "INFO" "Single tick completed. Active: $($state.active_seconds)s, Idle: $($state.idle_seconds)s, Pauses: $($state.pause_count)"
    return
}

# Main Background Loop with Graceful Exit Handling
try {
    while ($true) {
        Start-Sleep -Seconds $tickIntervalSec
        Perform-Tick -StateRef ([ref]$state) -CurrentDateRef ([ref]$currentDate) -LastTickTimeRef ([ref]$lastTickTime) -LastSyncTimeRef ([ref]$lastSyncTime) -ActivitiesRef ([ref]$activities) -LastScreenshotTimeRef ([ref]$lastScreenshotTime)
    }
}
finally {
    Write-AgentLog "INFO" "Vserve-TimeChamp Agent shutting down. Flushing final state..."
    $state["last_flush_utc"] = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
    Save-AgentStateAtomic -State $state -Dir $resolvedLocalPath
    Save-DailyCsv -State $state -Dir $resolvedLocalPath
    if ($enableAppTracking) {
        Save-ActivitiesData -Activities $activities -DateStr $currentDate -User $user -Dir $resolvedLocalPath
    }

    # Final sync on exit/logoff
    $finalCsv = Join-Path $resolvedLocalPath "daily_$currentDate.csv"
    $loggerSb = { param($lvl, $msg) Write-AgentLog $lvl $msg }
    Invoke-SyncTransport -LocalFilePath $finalCsv -User $user -Date $currentDate -Config $config -Logger $loggerSb | Out-Null

    $finalActCsv = Join-Path $resolvedLocalPath "activities_$currentDate.csv"
    if (Test-Path $finalActCsv) {
        Invoke-SyncTransport -LocalFilePath $finalActCsv -User $user -Date $currentDate -Config $config -Logger $loggerSb | Out-Null
    }

    if ($agentMutex) {
        try { $agentMutex.ReleaseMutex() } catch {}
        $agentMutex.Dispose()
    }
    Write-AgentLog "INFO" "Vserve-TimeChamp Agent shutdown complete."
}
