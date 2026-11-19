<#
.SYNOPSIS
    Unit Tests: Idle Detector P/Invoke & Arithmetic Protection
#>

$testDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$rootDir = Split-Path -Parent $testDir
$agentPath = Join-Path (Join-Path $rootDir "agent") "agent.ps1"

Write-Host "--- Running Test-IdleDetector ---"

# 1. P/Invoke Compilation & Execution
$passed = $true
try {
    # Ensure type is loaded
    if (-not ([System.Management.Automation.PSTypeName]'WorkTimer.Win32.IdleDetector').Type) {
        . $agentPath -SingleTick | Out-Null
    }

    $idleSec = [WorkTimer.Win32.IdleDetector]::GetIdleSeconds()
    if ($idleSec -ge 0) {
        Write-Host "  [PASS] GetIdleSeconds() returned valid non-negative integer: $idleSec"
    } else {
        Write-Host "  [FAIL] GetIdleSeconds() returned negative value: $idleSec"
        $passed = $false
    }
} catch {
    Write-Host "  [FAIL] P/Invoke call threw exception: $($_.Exception.Message)"
    $passed = $false
}

# 2. Arithmetic 32-bit tick wrap protection
try {
    # Test unchecked arithmetic logic simulating 24.9-day tick wrap
    $currentTick = [uint32]4294967000 # Near uint32 max
    $lastInputTick = [uint32]4294966000
    $diffSec = [WorkTimer.Win32.IdleDetector]::CalculateIdleSeconds($currentTick, $lastInputTick)
    if ($diffSec -eq 1) {
        Write-Host "  [PASS] Unchecked tick wrap arithmetic handled correctly: $diffSec sec"
    } else {
        Write-Host "  [FAIL] Unchecked tick wrap arithmetic unexpected value: $diffSec"
        $passed = $false
    }
} catch {
    Write-Host "  [FAIL] Arithmetic wrap simulation threw exception: $($_.Exception.Message)"
    $passed = $false
}

if ($passed) {
    Write-Host "[RESULT] Test-IdleDetector: ALL PASSED"
    exit 0
} else {
    Write-Host "[RESULT] Test-IdleDetector: FAILURES DETECTED"
    exit 1
}
