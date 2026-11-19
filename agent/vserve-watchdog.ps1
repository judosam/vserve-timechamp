<#
.SYNOPSIS
    Vserve-TimeChamp Always-On Watchdog Service (Replicates Aos.TimeChamp.exe)
.DESCRIPTION
    Runs as a silent background keeper process for the current user.
    Monitors the Vserve-TimeChamp Agent process and automatically relaunches it
    if it is terminated unexpectedly or crashes.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [switch]$Stop,

    [Parameter(Mandatory = $false)]
    [switch]$Status,

    [Parameter(Mandatory = $false)]
    [int]$CheckIntervalSeconds = 45,

    [Parameter(Mandatory = $false)]
    [string]$ConfigPath
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
if ([string]::IsNullOrEmpty($scriptDir)) { $scriptDir = (Get-Location).Path }

$agentScript = Join-Path $scriptDir "agent.ps1"
$launcherVbs = Join-Path $scriptDir "launcher.vbs"

$user = [System.Environment]::UserName
$localDataDir = Join-Path $env:LOCALAPPDATA "VserveTimeChamp"
if (-not (Test-Path $localDataDir)) { New-Item -ItemType Directory -Path $localDataDir -Force | Out-Null }
$watchdogLog = Join-Path $localDataDir "watchdog.log"
$stopSignalFile = Join-Path $localDataDir ".stop_requested"

function Log-Watchdog([string]$level, [string]$msg) {
    $ts = [DateTime]::UtcNow.ToString("yyyy-MM-dd HH:mm:ss.fffZ")
    $line = "[$ts] [$level] $msg"
    try {
        [System.IO.File]::AppendAllText($watchdogLog, "$line`r`n", [System.Text.Encoding]::UTF8)
    } catch {}
}

# -------------------------------------------------------------------------
# Handle -Stop and -Status
# -------------------------------------------------------------------------
if ($Stop) {
    Write-Host "Stopping Vserve-TimeChamp Watchdog for user '$user'..."
    # Create stop signal so watchdog does not revive agent
    [System.IO.File]::WriteAllText($stopSignalFile, "STOP", [System.Text.Encoding]::UTF8)

    $currentPid = $PID
    $stopped = 0
    try {
        $processes = Get-CimInstance Win32_Process | Where-Object {
            $_.ProcessId -ne $currentPid -and
            ($_.CommandLine -match 'vserve-watchdog\.ps1' -or $_.CommandLine -match 'launcher-watchdog\.vbs')
        }
        foreach ($p in $processes) {
            Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
            $stopped++
        }
    } catch {}
    Write-Host "Vserve-TimeChamp Watchdog stopped ($stopped process(es) terminated)."
    return
}

if ($Status) {
    Write-Host "=== Vserve-TimeChamp Watchdog Status ==="
    $procs = Get-CimInstance Win32_Process | Where-Object {
        $_.ProcessId -ne $PID -and
        $_.CommandLine -match 'vserve-watchdog\.ps1'
    }
    if ($procs) {
        Write-Host "Watchdog Status: RUNNING (PID: $(($procs | Select-Object -ExpandProperty ProcessId) -join ', '))"
    } else {
        Write-Host "Watchdog Status: NOT RUNNING"
    }
    return
}

# -------------------------------------------------------------------------
# Single-Instance Mutex for Watchdog
# -------------------------------------------------------------------------
$mutexName = "Local\VserveTimeChamp_Watchdog_$user"
$createdNew = $false
try {
    $wdMutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$createdNew)
    if (-not $createdNew) {
        Log-Watchdog "WARN" "Watchdog already running for user '$user'. Exiting duplicate."
        return
    }
} catch {
    Log-Watchdog "WARN" "Watchdog mutex error: $($_.Exception.Message)"
}

# Remove existing stop signal on normal start
if (Test-Path $stopSignalFile) {
    Remove-Item $stopSignalFile -Force -ErrorAction SilentlyContinue
}

Log-Watchdog "INFO" "Vserve-TimeChamp Watchdog started for user '$user'. Checking every ${CheckIntervalSeconds}s."

try {
    while ($true) {
        Start-Sleep -Seconds $CheckIntervalSeconds

        # Check if stop was requested
        if (Test-Path $stopSignalFile) {
            Log-Watchdog "INFO" "Stop signal detected. Watchdog shutting down gracefully."
            break
        }

        # Check if agent is running
        $agentProcs = Get-CimInstance Win32_Process | Where-Object {
            $_.ProcessId -ne $PID -and
            $_.CommandLine -match 'agent\.ps1' -and
            $_.CommandLine -notmatch '-(Status|SingleTick|Stop)\b'
        }

        if (-not $agentProcs) {
            Log-Watchdog "WARN" "Agent process not detected! Auto-restarting agent (KickStartProcess)..."
            try {
                if (Test-Path $launcherVbs) {
                    Start-Process -FilePath "wscript.exe" -ArgumentList "`"$launcherVbs`"", "`"$agentScript`"" -WindowStyle Hidden
                } else {
                    Start-Process -FilePath "powershell.exe" -ArgumentList "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$agentScript`"" -WindowStyle Hidden
                }
                Log-Watchdog "INFO" "Agent kick-started successfully."
            }
            catch {
                Log-Watchdog "ERROR" "Failed to restart agent: $($_.Exception.Message)"
            }
        }
    }
}
finally {
    if ($wdMutex) {
        try { $wdMutex.ReleaseMutex() } catch {}
        $wdMutex.Dispose()
    }
    Log-Watchdog "INFO" "Vserve-TimeChamp Watchdog exited."
}
