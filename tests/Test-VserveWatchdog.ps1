<#
.SYNOPSIS
    Unit Tests: Vserve-TimeChamp Watchdog (Replicating Aos.TimeChamp.exe)
#>

$testDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$rootDir = Split-Path -Parent $testDir
$watchdogScript = Join-Path (Join-Path $rootDir "agent") "vserve-watchdog.ps1"

Write-Host "--- Running Test-VserveWatchdog ---"
$allPassed = $true

if (-not (Test-Path $watchdogScript)) {
    Write-Host "  [FAIL] vserve-watchdog.ps1 not found at $watchdogScript"
    exit 1
}

# 1. Test Status check when not running
$outputStatus = powershell.exe -NoProfile -ExecutionPolicy Bypass -File $watchdogScript -Status
if ($outputStatus -match "Watchdog Status") {
    Write-Host "  [PASS] Watchdog -Status returned expected output."
} else {
    Write-Host "  [FAIL] Watchdog -Status output unexpected: $outputStatus"
    $allPassed = $false
}

# 2. Test Stop handling
$outputStop = powershell.exe -NoProfile -ExecutionPolicy Bypass -File $watchdogScript -Stop
if ($outputStop -match "stopped") {
    Write-Host "  [PASS] Watchdog -Stop executed cleanly."
} else {
    Write-Host "  [FAIL] Watchdog -Stop failed: $outputStop"
    $allPassed = $false
}

if ($allPassed) {
    Write-Host "[RESULT] Test-VserveWatchdog: ALL PASSED"
    exit 0
} else {
    Write-Host "[RESULT] Test-VserveWatchdog: SOME TESTS FAILED"
    exit 1
}
