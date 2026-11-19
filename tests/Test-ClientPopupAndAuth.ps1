<#
.SYNOPSIS
    Unit Tests: Client Popup Widget Authentication & Live Sync API
#>

$testDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$rootDir = Split-Path -Parent $testDir
$serverJs = Join-Path (Join-Path $rootDir "admin") "server.js"

Write-Host "--- Running Test-ClientPopupAndAuth ---"
$allPassed = $true

# Start server on test port 3098
$env:PORT = "3098"
$serverProc = Start-Process -FilePath "node" -ArgumentList "`"$serverJs`"" -PassThru
Start-Sleep -Seconds 2

try {
    # 1. Test Client Binary Download Endpoint
    $dl = Invoke-WebRequest -Uri "http://localhost:3098/download/vserve-timechamp-setup.exe" -Method GET -UseBasicParsing
    if ($dl.StatusCode -eq 200 -and $dl.Headers["Content-Disposition"] -match "vserve-timechamp-setup.exe") {
        Write-Host "  [PASS] GET /download/vserve-timechamp-setup.exe served valid binary."
    } else {
        Write-Host "  [FAIL] Binary download endpoint failed."
        $allPassed = $false
    }

    # 2. Test User Creation in Admin Portal
    $newUser = @{
        username = "alex.turner"
        displayName = "Alex Turner"
        department = "Engineering"
        role = "Frontend Architect"
        machine = "ALEX-WORKSTATION"
        targetDailyHours = 8.0
        idleThresholdSeconds = 600
    } | ConvertTo-Json

    $createRes = Invoke-RestMethod -Uri "http://localhost:3098/api/users" -Method POST -Body $newUser -ContentType "application/json"
    if ($createRes.success -and $createRes.user.username -eq "alex.turner") {
        Write-Host "  [PASS] POST /api/users created employee account 'alex.turner'."
    } else {
        Write-Host "  [FAIL] Failed to create user in Admin Portal."
        $allPassed = $false
    }

    # 3. Test Client Login for Created User
    $loginPayload = @{ username = "alex.turner" } | ConvertTo-Json
    $loginRes = Invoke-RestMethod -Uri "http://localhost:3098/api/client/login" -Method POST -Body $loginPayload -ContentType "application/json"
    if ($loginRes.success -and $loginRes.user.displayName -eq "Alex Turner") {
        Write-Host "  [PASS] POST /api/client/login authenticated created user successfully."
    } else {
        Write-Host "  [FAIL] Client login authentication failed."
        $allPassed = $false
    }

    # 4. Test Client Login for Non-Existent User
    try {
        Invoke-RestMethod -Uri "http://localhost:3098/api/client/login" -Method POST -Body (@{ username = "unknown_user_12345" } | ConvertTo-Json) -ContentType "application/json"
        Write-Host "  [FAIL] Client login should have failed for unknown user."
        $allPassed = $false
    } catch {
        if ($_.Exception.Response.StatusCode.value__ -eq 404) {
            Write-Host "  [PASS] Client login for unknown user properly rejected with 404."
        } else {
            Write-Host "  [FAIL] Unexpected error code for unknown user."
            $allPassed = $false
        }
    }

    # 5. Clean up created test user
    Invoke-RestMethod -Uri "http://localhost:3098/api/users/alex.turner" -Method DELETE | Out-Null
    Write-Host "  [PASS] Test user cleaned up cleanly."
}
finally {
    if ($serverProc -and -not $serverProc.HasExited) {
        Stop-Process -Id $serverProc.Id -Force -ErrorAction SilentlyContinue
    }
}

if ($allPassed) {
    Write-Host "[RESULT] Test-ClientPopupAndAuth: ALL PASSED"
    exit 0
} else {
    Write-Host "[RESULT] Test-ClientPopupAndAuth: FAILURES DETECTED"
    exit 1
}
