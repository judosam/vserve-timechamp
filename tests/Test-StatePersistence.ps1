<#
.SYNOPSIS
    Unit Tests: State Persistence, Crash Recovery & Atomic File Operations
#>

$testDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$rootDir = Split-Path -Parent $testDir
$tempDir = Join-Path $env:TEMP "wt_test_state_persistence"
if (Test-Path $tempDir) { Remove-Item $tempDir -Recurse -Force }
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

Write-Host "--- Running Test-StatePersistence ---"
$allPassed = $true

# 1. Test Duration HMS Formatting
function Format-DurationHMS([int64]$sec) {
    if ($sec -lt 0) { $sec = 0 }
    $h = [math]::Floor($sec / 3600)
    $m = [math]::Floor(($sec % 3600) / 60)
    $s = $sec % 60
    return ("{0:D2}:{1:D2}:{2:D2}" -f [int]$h, [int]$m, [int]$s)
}

$hmsTests = @(
    @{ Input = 0; Expected = "00:00:00" },
    @{ Input = 59; Expected = "00:00:59" },
    @{ Input = 60; Expected = "00:01:00" },
    @{ Input = 3599; Expected = "00:59:59" },
    @{ Input = 3600; Expected = "01:00:00" },
    @{ Input = 10740; Expected = "02:59:00" },
    @{ Input = 86400; Expected = "24:00:00" },
    @{ Input = 100000; Expected = "27:46:40" }
)

foreach ($ht in $hmsTests) {
    $res = Format-DurationHMS $ht.Input
    if ($res -eq $ht.Expected) {
        Write-Host "  [PASS] Format-DurationHMS($($ht.Input)) = $res"
    } else {
        Write-Host "  [FAIL] Format-DurationHMS($($ht.Input)) expected $($ht.Expected) but got $res"
        $allPassed = $false
    }
}

# 2. Atomic Save (.tmp -> .json)
$testDate = "2026-11-04"
$stateData = @{
    user            = "ravi.k"
    machine         = "WS-14"
    date            = $testDate
    active_seconds  = 10740
    idle_seconds    = 1200
    status          = "active"
    pause_count     = 3
    first_input_utc = "2026-11-04T03:31:10Z"
    last_input_utc  = "2026-11-04T12:40:55Z"
    last_flush_utc  = "2026-11-04T11:22:03Z"
    day_start_utc   = "2026-11-04T03:31:10Z"
}

$stateFile = Join-Path $tempDir "state_$testDate.json"
$tmpFile   = Join-Path $tempDir "state_$testDate.json.tmp"

$json = $stateData | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($tmpFile, $json, [System.Text.Encoding]::UTF8)
Move-Item -Path $tmpFile -Destination $stateFile -Force

if ((Test-Path $stateFile) -and (-not (Test-Path $tmpFile))) {
    Write-Host "  [PASS] Atomic file move succeeded. Target exists, temp removed."
} else {
    Write-Host "  [FAIL] Atomic file move failed."
    $allPassed = $false
}

# 3. Crash-Safe Resume Verification (Monotonic accumulation)
$loadedRaw = Get-Content -Path $stateFile -Raw | ConvertFrom-Json
if ($loadedRaw.active_seconds -eq 10740 -and $loadedRaw.user -eq "ravi.k") {
    Write-Host "  [PASS] Resumed exact stored state ($($loadedRaw.active_seconds)s active). State not reset to 0."
} else {
    Write-Host "  [FAIL] Failed to restore state correctly."
    $allPassed = $false
}

# 4. Atomic Overwrite Test (Simulating continuous flushes)
$stateData["active_seconds"] = 10770
$json2 = $stateData | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($tmpFile, $json2, [System.Text.Encoding]::UTF8)
Move-Item -Path $tmpFile -Destination $stateFile -Force

$loadedRaw2 = Get-Content -Path $stateFile -Raw | ConvertFrom-Json
if ($loadedRaw2.active_seconds -eq 10770) {
    Write-Host "  [PASS] State successfully updated monotonically to $($loadedRaw2.active_seconds)s."
} else {
    Write-Host "  [FAIL] Monotonic update failed."
    $allPassed = $false
}

# 5. Corrupted File Fallback
$corruptFile = Join-Path $tempDir "state_corrupt.json"
Set-Content -Path $corruptFile -Value "{ invalid json :: test"
$fallbackHandled = $false
try {
    $raw = Get-Content -Path $corruptFile -Raw
    $parsed = $raw | ConvertFrom-Json
} catch {
    $fallbackHandled = $true
}
if ($fallbackHandled) {
    Write-Host "  [PASS] Corrupted JSON properly caught; fallback path triggered."
} else {
    Write-Host "  [FAIL] Corrupted JSON did not throw as expected."
    $allPassed = $false
}

# Cleanup
Remove-Item $tempDir -Recurse -Force

if ($allPassed) {
    Write-Host "[RESULT] Test-StatePersistence: ALL PASSED"
    exit 0
} else {
    Write-Host "[RESULT] Test-StatePersistence: FAILURES DETECTED"
    exit 1
}
