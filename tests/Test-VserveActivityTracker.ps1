<#
.SYNOPSIS
    Unit Tests: Vserve-TimeChamp Activity, Window, and Browser Tracking
#>

$testDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$rootDir = Split-Path -Parent $testDir
$trackerModule = Join-Path (Join-Path $rootDir "agent") "Vserve-ActivityTracker.ps1"

Write-Host "--- Running Test-VserveActivityTracker ---"
$allPassed = $true

if (-not (Test-Path $trackerModule)) {
    Write-Host "  [FAIL] Vserve-ActivityTracker.ps1 module not found at $trackerModule"
    exit 1
}

. $trackerModule

# 1. Test Window Snapshot
$snap = Get-ActiveWindowSnapshot
if ($snap -and $snap.ProcessName -ne $null) {
    Write-Host "  [PASS] Get-ActiveWindowSnapshot returned valid object: Process='$($snap.ProcessName)', PID=$($snap.ProcessId)"
} else {
    Write-Host "  [FAIL] Get-ActiveWindowSnapshot failed"
    $allPassed = $false
}

# 2. Test Domain Extraction from URLs
$cases = @(
    @{ Url = "https://github.com/solidtime-io/solidtime"; Expected = "github.com" },
    @{ Url = "http://www.vservesolution.com/careers"; Expected = "www.vservesolution.com" },
    @{ Url = "https://sub.app.brightedge.com/login?q=1"; Expected = "sub.app.brightedge.com" },
    @{ Url = ""; Expected = "" }
)

foreach ($c in $cases) {
    $res = Get-DomainFromUrl -Url $c.Url
    if ($res -eq $c.Expected) {
        Write-Host "  [PASS] Get-DomainFromUrl('$($c.Url)') = '$res'"
    } else {
        Write-Host "  [FAIL] Get-DomainFromUrl('$($c.Url)') expected '$($c.Expected)' but got '$res'"
        $allPassed = $false
    }
}

# 3. Test Productivity Classification
$rules = [PSCustomObject]@{
    productiveApps = @("code.exe", "excel.exe", "teams.exe")
    unproductiveApps = @("spotify.exe", "steam.exe")
    productiveUrls = @("github.com", "vservesolution.com")
    unproductiveUrls = @("facebook.com", "netflix.com")
}

$eval1 = Get-ProductivityScore -ProcessName "code.exe" -Url "" -Rules $rules
$eval2 = Get-ProductivityScore -ProcessName "chrome.exe" -Url "https://github.com/solidtime-io/solidtime" -Rules $rules
$eval3 = Get-ProductivityScore -ProcessName "chrome.exe" -Url "https://www.facebook.com" -Rules $rules
$eval4 = Get-ProductivityScore -ProcessName "notepad.exe" -Url "" -Rules $rules

if ($eval1 -eq "Productive") {
    Write-Host "  [PASS] code.exe classified as Productive"
} else {
    Write-Host "  [FAIL] code.exe expected Productive, got $eval1"
    $allPassed = $false
}

if ($eval2 -eq "Productive") {
    Write-Host "  [PASS] github.com classified as Productive"
} else {
    Write-Host "  [FAIL] github.com expected Productive, got $eval2"
    $allPassed = $false
}

if ($eval3 -eq "Unproductive") {
    Write-Host "  [PASS] facebook.com classified as Unproductive"
} else {
    Write-Host "  [FAIL] facebook.com expected Unproductive, got $eval3"
    $allPassed = $false
}

if ($eval4 -eq "Neutral") {
    Write-Host "  [PASS] notepad.exe classified as Neutral"
} else {
    Write-Host "  [FAIL] notepad.exe expected Neutral, got $eval4"
    $allPassed = $false
}

# 4. Test Activities Persistence Functionality
$tempActDir = Join-Path $env:TEMP "vserve_test_activities"
if (Test-Path $tempActDir) { Remove-Item $tempActDir -Recurse -Force }
New-Item -ItemType Directory -Path $tempActDir -Force | Out-Null

$testDate = "2026-11-19"
$testUser = "ravi.k"
$sampleActivities = @{
    "applications" = @{
        "code.exe"  = @{ "seconds" = 3600; "classification" = "Productive" }
        "teams.exe" = @{ "seconds" = 1800; "classification" = "Productive" }
    }
    "websites" = @{
        "github.com" = @{ "seconds" = 2400; "classification" = "Productive" }
    }
}

# Execute agent script function Save-ActivitiesData in local scope
$agentScript = Join-Path (Join-Path $rootDir "agent") "agent.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $agentScript `
    -LocalDataPath $tempActDir `
    -MockDate $testDate `
    -MockIdleSeconds 5 `
    -TickInterval 30 `
    -SingleTick | Out-Null

$actJsonFile = Join-Path $tempActDir "activities_$testDate.json"
$actCsvFile = Join-Path $tempActDir "activities_$testDate.csv"

if (Test-Path $actJsonFile) {
    Write-Host "  [PASS] activities_$testDate.json generated successfully."
} else {
    Write-Host "  [FAIL] activities_$testDate.json not generated."
    $allPassed = $false
}

if (Test-Path $actCsvFile) {
    Write-Host "  [PASS] activities_$testDate.csv generated successfully."
} else {
    Write-Host "  [FAIL] activities_$testDate.csv not generated."
    $allPassed = $false
}

if (Test-Path $tempActDir) { Remove-Item $tempActDir -Recurse -Force -ErrorAction SilentlyContinue }

if ($allPassed) {
    Write-Host "[RESULT] Test-VserveActivityTracker: ALL PASSED"
    exit 0
} else {
    Write-Host "[RESULT] Test-VserveActivityTracker: SOME TESTS FAILED"
    exit 1
}
