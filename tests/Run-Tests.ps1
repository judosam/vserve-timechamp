<#
.SYNOPSIS
    Vserve-TimeChamp - Master Test Runner
.DESCRIPTION
    Executes all automated test suites across all components:
    - Test-IdleDetector.ps1 (Win32 P/Invoke & tick wrap protection)
    - Test-StatePersistence.ps1 (Atomic persistence, crash recovery, HMS formatting)
    - Test-AccumulationLogic.ps1 (Idle/Active transitions, pause tracking, sleep cap, rollover)
    - Test-SyncTransport.ps1 (Option A Share sync, offline tolerance, backlog catch-up)
    - Test-AdminReport.ps1 (Daily, Weekly, Monthly, Custom reporting, OpenXML multi-sheet Excel)
    - Test-Installer.ps1 (No-admin user installer and uninstaller idempotency)
    - Test-VserveActivityTracker.ps1 (Window snapshot, UI Automation URL tracking, productivity rules)
    - Test-VserveWatchdog.ps1 (Always-On Watchdog status, mutex, and stop signal)
#>

$testDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
if ([string]::IsNullOrEmpty($testDir)) { $testDir = (Get-Location).Path }

$testSuites = @(
    "Test-IdleDetector.ps1",
    "Test-StatePersistence.ps1",
    "Test-AccumulationLogic.ps1",
    "Test-SyncTransport.ps1",
    "Test-AdminReport.ps1",
    "Test-Installer.ps1",
    "Test-VserveActivityTracker.ps1",
    "Test-VserveWatchdog.ps1",
    "Test-LiveServer.ps1",
    "Test-ClientPopupAndAuth.ps1"
)

Write-Host "=========================================================="
Write-Host "       Vserve-TimeChamp Automated Test Suite"
Write-Host "=========================================================="

$totalPassed = 0
$totalFailed = 0
$startTime = [DateTime]::UtcNow

foreach ($testName in $testSuites) {
    $testScript = Join-Path $testDir $testName
    if (-not (Test-Path $testScript)) {
        Write-Warning "Test script missing: $testScript"
        $totalFailed++
        continue
    }

    Write-Host ""
    Write-Host ">>> Executing $testName..." -ForegroundColor Cyan
    $proc = Start-Process -FilePath "powershell.exe" `
        -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$testScript`"" `
        -NoNewWindow -Wait -PassThru

    if ($proc.ExitCode -eq 0) {
        Write-Host ">>> $testName : PASSED" -ForegroundColor Green
        $totalPassed++
    } else {
        Write-Host ">>> $testName : FAILED (ExitCode: $($proc.ExitCode))" -ForegroundColor Red
        $totalFailed++
    }
}

$elapsed = ([DateTime]::UtcNow - $startTime).TotalSeconds

Write-Host ""
Write-Host "=========================================================="
Write-Host "                   Test Results Summary"
Write-Host "=========================================================="
Write-Host "Total Suites: $(($totalPassed + $totalFailed))"
Write-Host "Passed:       $totalPassed" -ForegroundColor Green
Write-Host "Failed:       $totalFailed" -ForegroundColor $(if ($totalFailed -eq 0) { "Green" } else { "Red" })
Write-Host "Total Time:   $([math]::Round($elapsed, 2)) seconds"
Write-Host "=========================================================="

if ($totalFailed -eq 0) {
    Write-Host "SUCCESS: All tests passed flawlessly!" -ForegroundColor Green
    exit 0
} else {
    Write-Host "FAILURE: Some test suites failed." -ForegroundColor Red
    exit 1
}
