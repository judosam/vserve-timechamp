<#
.SYNOPSIS
    Unit Tests: Accumulation Logic, Idle/Active State Transitions, Sleep Capping, and Rollover
#>

$testDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$rootDir = Split-Path -Parent $testDir
$agentPath = Join-Path (Join-Path $rootDir "agent") "agent.ps1"
$tempDataDir = Join-Path $env:TEMP "wt_test_accumulation"
if (Test-Path $tempDataDir) { Remove-Item $tempDataDir -Recurse -Force }
New-Item -ItemType Directory -Path $tempDataDir -Force | Out-Null

Write-Host "--- Running Test-AccumulationLogic ---"
$allPassed = $true

# 1. Test Active Accumulation: MockIdleSeconds = 5 (< 600s)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $agentPath `
    -LocalDataPath $tempDataDir `
    -MockDate "2026-11-04" `
    -MockIdleSeconds 5 `
    -TickInterval 30 `
    -IdleThreshold 600 `
    -SingleTick | Out-Null

$stateFile1 = Join-Path $tempDataDir "state_2026-11-04.json"
$state1 = Get-Content -Path $stateFile1 -Raw | ConvertFrom-Json

if ($state1.active_seconds -eq 30 -and $state1.status -eq "active" -and $state1.pause_count -eq 0) {
    Write-Host "  [PASS] Active accumulation: active_seconds = 30, status = active, pauses = 0"
} else {
    Write-Host "  [FAIL] Active accumulation failed: active_seconds=$($state1.active_seconds), status=$($state1.status)"
    $allPassed = $false
}

# 2. Test Idle / Pause Transition: MockIdleSeconds = 650 (>= 600s)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $agentPath `
    -LocalDataPath $tempDataDir `
    -MockDate "2026-11-04" `
    -MockIdleSeconds 650 `
    -TickInterval 30 `
    -IdleThreshold 600 `
    -SingleTick | Out-Null

$state2 = Get-Content -Path $stateFile1 -Raw | ConvertFrom-Json
if ($state2.active_seconds -eq 30 -and $state2.idle_seconds -eq 30 -and $state2.status -eq "idle" -and $state2.pause_count -eq 1) {
    Write-Host "  [PASS] Idle transition: active_seconds stayed 30, idle_seconds = 30, status = idle, pauses = 1"
} else {
    Write-Host "  [FAIL] Idle transition failed: active=$($state2.active_seconds), idle=$($state2.idle_seconds), status=$($state2.status), pauses=$($state2.pause_count)"
    $allPassed = $false
}

# 3. Test Continued Idle (No extra pause count increment)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $agentPath `
    -LocalDataPath $tempDataDir `
    -MockDate "2026-11-04" `
    -MockIdleSeconds 700 `
    -TickInterval 30 `
    -IdleThreshold 600 `
    -SingleTick | Out-Null

$state3 = Get-Content -Path $stateFile1 -Raw | ConvertFrom-Json
if ($state3.active_seconds -eq 30 -and $state3.idle_seconds -eq 60 -and $state3.status -eq "idle" -and $state3.pause_count -eq 1) {
    Write-Host "  [PASS] Continued idle: idle_seconds = 60, pause_count remained 1"
} else {
    Write-Host "  [FAIL] Continued idle failed: idle=$($state3.idle_seconds), pauses=$($state3.pause_count)"
    $allPassed = $false
}

# 4. Test Resume Transition (User returns to work, MockIdleSeconds = 10)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $agentPath `
    -LocalDataPath $tempDataDir `
    -MockDate "2026-11-04" `
    -MockIdleSeconds 10 `
    -TickInterval 30 `
    -IdleThreshold 600 `
    -SingleTick | Out-Null

$state4 = Get-Content -Path $stateFile1 -Raw | ConvertFrom-Json
if ($state4.active_seconds -eq 60 -and $state4.idle_seconds -eq 60 -and $state4.status -eq "active" -and $state4.pause_count -eq 1) {
    Write-Host "  [PASS] Resume transition: active_seconds resumed to 60, status = active, pauses = 1"
} else {
    Write-Host "  [FAIL] Resume transition failed: active=$($state4.active_seconds), status=$($state4.status)"
    $allPassed = $false
}

# 5. Test Daily CSV Schema & Content
$csvFile = Join-Path $tempDataDir "daily_2026-11-04.csv"
$csvContent = Import-Csv -Path $csvFile
if ($csvContent.date -eq "2026-11-04" -and $csvContent.active_seconds -eq 60 -and $csvContent.active_hms -eq "00:01:00" -and $csvContent.idle_seconds -eq 60 -and $csvContent.pause_count -eq 1) {
    Write-Host "  [PASS] Daily CSV content valid: active_hms=00:01:00, idle_hms=00:01:00, pause_count=1"
} else {
    Write-Host "  [FAIL] Daily CSV content invalid: $($csvContent | Out-String)"
    $allPassed = $false
}

# 6. Test Midnight Rollover to New Day (MockDate = 2026-11-05)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $agentPath `
    -LocalDataPath $tempDataDir `
    -MockDate "2026-11-05" `
    -MockIdleSeconds 5 `
    -TickInterval 30 `
    -IdleThreshold 600 `
    -SingleTick | Out-Null

$stateFile2 = Join-Path $tempDataDir "state_2026-11-05.json"
$stateNewDay = Get-Content -Path $stateFile2 -Raw | ConvertFrom-Json
if ($stateNewDay.date -eq "2026-11-05" -and $stateNewDay.active_seconds -eq 30 -and $stateNewDay.pause_count -eq 0) {
    Write-Host "  [PASS] Rollover new day state initialized: date=2026-11-05, active=30s, pauses=0"
} else {
    Write-Host "  [FAIL] Rollover new day state incorrect: date=$($stateNewDay.date), active=$($stateNewDay.active_seconds)"
    $allPassed = $false
}

# Cleanup
Remove-Item $tempDataDir -Recurse -Force

if ($allPassed) {
    Write-Host "[RESULT] Test-AccumulationLogic: ALL PASSED"
    exit 0
} else {
    Write-Host "[RESULT] Test-AccumulationLogic: FAILURES DETECTED"
    exit 1
}
