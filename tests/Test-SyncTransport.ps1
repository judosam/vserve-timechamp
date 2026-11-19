<#
.SYNOPSIS
    Unit Tests: Sync Transport (Option A Share, Offline Handling, Backlog Catchup)
#>

$testDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$rootDir = Split-Path -Parent $testDir
$syncModulePath = Join-Path (Join-Path $rootDir "sync") "Sync-Transport.ps1"
. $syncModulePath

$tempLocal   = Join-Path $env:TEMP "wt_test_sync_local"
$tempCentral = Join-Path $env:TEMP "wt_test_sync_central"

if (Test-Path $tempLocal)   { Remove-Item $tempLocal -Recurse -Force }
if (Test-Path $tempCentral) { Remove-Item $tempCentral -Recurse -Force }
New-Item -ItemType Directory -Path $tempLocal, $tempCentral -Force | Out-Null

Write-Host "--- Running Test-SyncTransport ---"
$allPassed = $true

# Prepare mock local CSV
$testDate = "2026-11-04"
$testUser = "ravi.k"
$localCsv = Join-Path $tempLocal "daily_$testDate.csv"
$csvData = @"
date,user,machine,active_seconds,active_hms,idle_seconds,idle_hms,first_input_utc,last_input_utc,pause_count
2026-11-04,ravi.k,WS-14,28800,08:00:00,3600,01:00:00,2026-11-04T03:30:00Z,2026-11-04T12:30:00Z,3
"@
Set-Content -Path $localCsv -Value $csvData

$config = [PSCustomObject]@{
    sync = [PSCustomObject]@{
        transport = "Share"
        share = [PSCustomObject]@{
            centralPath = $tempCentral
        }
    }
}

# 1. Test Option A Share Sync
$res = Invoke-SyncTransport -LocalFilePath $localCsv -User $testUser -Date $testDate -Config $config
$expectedCentralPath = Join-Path (Join-Path $tempCentral $testUser) "daily_${testUser}_${testDate}.csv"

if ($res -and (Test-Path $expectedCentralPath)) {
    Write-Host "  [PASS] Option A sync succeeded. Destination file exists: $expectedCentralPath"
} else {
    Write-Host "  [FAIL] Option A sync failed. File missing or returned false."
    $allPassed = $false
}

# 2. Test Offline Tolerance (Invalid Share Path)
$offlineConfig = [PSCustomObject]@{
    sync = [PSCustomObject]@{
        transport = "Share"
        share = [PSCustomObject]@{
            centralPath = "Z:\NonExistentDriveLetter\WorkTime"
        }
    }
}

$offlineHandled = $false
try {
    $resOffline = Invoke-SyncTransport -LocalFilePath $localCsv -User $testUser -Date $testDate -Config $offlineConfig
    if ($resOffline -eq $false) {
        $offlineHandled = $true
        Write-Host "  [PASS] Offline share path safely handled: returned false without crashing."
    } else {
        Write-Host "  [FAIL] Expected false for unreachable share path."
        $allPassed = $false
    }
} catch {
    Write-Host "  [FAIL] Offline share threw unhandled exception: $($_.Exception.Message)"
    $allPassed = $false
}

# 3. Test Backlog Catchup
# Create multiple daily CSVs locally
Set-Content -Path (Join-Path $tempLocal "daily_2026-11-01.csv") -Value $csvData
Set-Content -Path (Join-Path $tempLocal "daily_2026-11-02.csv") -Value $csvData
Set-Content -Path (Join-Path $tempLocal "daily_2026-11-03.csv") -Value $csvData

Sync-BacklogFiles -LocalDataPath $tempLocal -User $testUser -Config $config

$c1 = Join-Path (Join-Path $tempCentral $testUser) "daily_${testUser}_2026-11-01.csv"
$c2 = Join-Path (Join-Path $tempCentral $testUser) "daily_${testUser}_2026-11-02.csv"
$c3 = Join-Path (Join-Path $tempCentral $testUser) "daily_${testUser}_2026-11-03.csv"

if ((Test-Path $c1) -and (Test-Path $c2) -and (Test-Path $c3)) {
    Write-Host "  [PASS] Sync-BacklogFiles successfully synced all backlog files to central store."
} else {
    Write-Host "  [FAIL] Backlog sync missed files in central store."
    $allPassed = $false
}

# Cleanup
Remove-Item $tempLocal -Recurse -Force
Remove-Item $tempCentral -Recurse -Force

if ($allPassed) {
    Write-Host "[RESULT] Test-SyncTransport: ALL PASSED"
    exit 0
} else {
    Write-Host "[RESULT] Test-SyncTransport: FAILURES DETECTED"
    exit 1
}
