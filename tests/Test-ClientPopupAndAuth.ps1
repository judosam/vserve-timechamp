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

    # 2a. Test Unauthenticated Access to Admin API (Must return 401)
    try {
        Invoke-RestMethod -Uri "http://localhost:3098/api/users" -Method GET
        Write-Host "  [FAIL] Unauthenticated GET /api/users should have returned 401."
        $allPassed = $false
    } catch {
        if ($_.Exception.Response.StatusCode.value__ -eq 401) {
            Write-Host "  [PASS] Unauthenticated access to /api/users properly rejected with 401 Unauthorized."
        } else {
            Write-Host "  [FAIL] Expected 401 for unauthenticated /api/users, got $($_.Exception.Response.StatusCode.value__)"
            $allPassed = $false
        }
    }

    # 2b. Test Strict RBAC: Employee Account is Forbidden from Admin Portal Access (Must return 403)
    try {
        $empLogin = @{ username = "sarah.m" } | ConvertTo-Json
        Invoke-RestMethod -Uri "http://localhost:3098/api/admin/login" -Method POST -Body $empLogin -ContentType "application/json"
        Write-Host "  [FAIL] Employee 'sarah.m' should be denied Admin Portal access."
        $allPassed = $false
    } catch {
        if ($_.Exception.Response.StatusCode.value__ -eq 403) {
            Write-Host "  [PASS] Employee login to Admin Portal properly rejected with 403 Forbidden (RBAC Enforced)."
        } else {
            Write-Host "  [FAIL] Expected 403 Forbidden for employee admin login, got $($_.Exception.Response.StatusCode.value__)"
            $allPassed = $false
        }
    }

    # 2c. Test Administrator Login (Returns valid 24h Admin Session Token)
    $admLogin = @{ username = "Samuel P" } | ConvertTo-Json
    $admRes = Invoke-RestMethod -Uri "http://localhost:3098/api/admin/login" -Method POST -Body $admLogin -ContentType "application/json"
    if ($admRes.success -and $admRes.token) {
        $adminToken = $admRes.token
        Write-Host "  [PASS] Administrator 'Samuel P' successfully authenticated to Admin Portal with session token."
    } else {
        Write-Host "  [FAIL] Administrator login failed."
        $allPassed = $false
    }

    $adminHeaders = @{ "X-Admin-Token" = $adminToken }

    # 2d. Test Sanitized Client Roster (Public for desktop client login dropdown)
    $roster = Invoke-RestMethod -Uri "http://localhost:3098/api/client/roster" -Method GET
    if ($roster -is [System.Array] -and $roster.Count -gt 0 -and $roster[0].username) {
        Write-Host "  [PASS] GET /api/client/roster returned sanitized user roster ($($roster.Count) accounts) for client dropdown."
    } else {
        Write-Host "  [FAIL] GET /api/client/roster failed."
        $allPassed = $false
    }

    # 3. Test User Creation in Admin Portal with Admin Token
    $newUser = @{
        username = "alex.turner"
        displayName = "Alex Turner"
        department = "Engineering"
        role = "Frontend Architect"
        machine = "ALEX-WORKSTATION"
        targetDailyHours = 8.0
        idleThresholdSeconds = 600
    } | ConvertTo-Json

    $createRes = Invoke-RestMethod -Uri "http://localhost:3098/api/users" -Method POST -Body $newUser -ContentType "application/json" -Headers $adminHeaders
    if ($createRes.success -and $createRes.user.username -eq "alex.turner") {
        Write-Host "  [PASS] POST /api/users created employee account 'alex.turner'."
    } else {
        Write-Host "  [FAIL] Failed to create user in Admin Portal."
        $allPassed = $false
    }

    # 4. Test Client Login for Created User (Desktop Client Tracking Endpoint)
    $loginPayload = @{ username = "alex.turner" } | ConvertTo-Json
    $loginRes = Invoke-RestMethod -Uri "http://localhost:3098/api/client/login" -Method POST -Body $loginPayload -ContentType "application/json"
    if ($loginRes.success -and $loginRes.user.displayName -eq "Alex Turner") {
        Write-Host "  [PASS] POST /api/client/login authenticated created user successfully."
    } else {
        Write-Host "  [FAIL] Client login authentication failed."
        $allPassed = $false
    }

    # 4b. Test Password Protection & Enforcement
    $pwdUser = @{
        username = "charlie.pass"
        displayName = "Charlie Protected"
        password = "SecurePIN987"
        department = "Security"
    } | ConvertTo-Json
    Invoke-RestMethod -Uri "http://localhost:3098/api/users" -Method POST -Body $pwdUser -ContentType "application/json" -Headers $adminHeaders | Out-Null

    # Test 3b-i: Empty password on protected account must fail with 401
    try {
        Invoke-RestMethod -Uri "http://localhost:3098/api/client/login" -Method POST -Body (@{ username = "charlie.pass"; password = "" } | ConvertTo-Json) -ContentType "application/json"
        Write-Host "  [FAIL] Protected account should reject empty password."
        $allPassed = $false
    } catch {
        if ($_.Exception.Response.StatusCode.value__ -eq 401) {
            Write-Host "  [PASS] Protected account properly rejected empty password with 401."
        } else {
            Write-Host "  [FAIL] Expected 401 for empty password, got $($_.Exception.Response.StatusCode.value__)"
            $allPassed = $false
        }
    }

    # Test 3b-ii: Wrong password on protected account must fail with 401
    try {
        Invoke-RestMethod -Uri "http://localhost:3098/api/client/login" -Method POST -Body (@{ username = "charlie.pass"; password = "WrongPassword" } | ConvertTo-Json) -ContentType "application/json"
        Write-Host "  [FAIL] Protected account should reject incorrect password."
        $allPassed = $false
    } catch {
        if ($_.Exception.Response.StatusCode.value__ -eq 401) {
            Write-Host "  [PASS] Protected account properly rejected incorrect password with 401."
        } else {
            Write-Host "  [FAIL] Expected 401 for incorrect password, got $($_.Exception.Response.StatusCode.value__)"
            $allPassed = $false
        }
    }

    # Test 3b-iii: Correct password succeeds
    $authOk = Invoke-RestMethod -Uri "http://localhost:3098/api/client/login" -Method POST -Body (@{ username = "charlie.pass"; password = "SecurePIN987" } | ConvertTo-Json) -ContentType "application/json"
    if ($authOk.success) {
        Write-Host "  [PASS] Protected account successfully authenticated with correct PIN."
    } else {
        Write-Host "  [FAIL] Correct password authentication failed."
        $allPassed = $false
    }

    # Clean up charlie.pass
    Invoke-RestMethod -Uri "http://localhost:3098/api/users/charlie.pass" -Method DELETE -Headers $adminHeaders | Out-Null

    # 5. Test Client Login for Non-Existent User (Returns 404)
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

    # 6. Test Live Telemetry returns full roster (with Admin Token)
    $liveData = Invoke-RestMethod -Uri "http://localhost:3098/api/live" -Method GET -Headers $adminHeaders
    $hasAlex = $liveData | Where-Object { $_.user -eq "alex.turner" }
    if ($hasAlex -and ($hasAlex.effectiveStatus -eq "Offline" -or $hasAlex.status -eq "Offline")) {
        Write-Host "  [PASS] GET /api/live properly included registered fleet employee 'alex.turner' as Offline."
    } else {
        Write-Host "  [FAIL] Registered user 'alex.turner' not found in /api/live."
        $allPassed = $false
    }

    # 7. Test Screenshots API endpoints (with Admin Token)
    $ssList = Invoke-RestMethod -Uri "http://localhost:3098/api/screenshots" -Method GET -Headers $adminHeaders
    if ($ssList -is [System.Array]) {
        Write-Host "  [PASS] GET /api/screenshots returned valid array ($($ssList.Count) items)."
    } else {
        Write-Host "  [FAIL] GET /api/screenshots did not return an array."
        $allPassed = $false
    }

    $ssCapture = Invoke-RestMethod -Uri "http://localhost:3098/api/screenshots/capture" -Method POST -Headers $adminHeaders
    if ($ssCapture.success -and $ssCapture.screenshot.filename) {
        Write-Host "  [PASS] POST /api/screenshots/capture successfully captured desktop evidence: $($ssCapture.screenshot.filename)"

        # Verify image serving endpoint
        $ssUrl = "http://localhost:3098" + $ssCapture.screenshot.url
        $imgRes = Invoke-WebRequest -Uri $ssUrl -Method GET -Headers $adminHeaders -UseBasicParsing
        if ($imgRes.StatusCode -eq 200 -and $imgRes.Headers["Content-Type"] -match "image") {
            Write-Host "  [PASS] GET $($ssCapture.screenshot.url) successfully streamed image binary."
        } else {
            Write-Host "  [FAIL] Failed to stream screenshot image binary."
            $allPassed = $false
        }
    } else {
        Write-Host "  [FAIL] POST /api/screenshots/capture failed."
        $allPassed = $false
    }

    # 8. Clean up created test user
    Invoke-RestMethod -Uri "http://localhost:3098/api/users/alex.turner" -Method DELETE -Headers $adminHeaders | Out-Null
    Write-Host "  [PASS] Test user cleaned up cleanly."

    # 9. Verify Client Executable has ZERO Portal access (RBAC Client Isolation)
    $clientCs = Join-Path $rootDir "deploy\VserveClientTemplate.cs"
    $hasPortalBtn = Select-String -Path $clientCs -Pattern 'btnOpenPortal' -Quiet
    $hasPortalTray = Select-String -Path $clientCs -Pattern 'itemPortal' -Quiet
    if (-not $hasPortalBtn -and -not $hasPortalTray) {
        Write-Host "  [PASS] Client executable verified: Zero web portal buttons or menu items present (Portal access restricted to admin)."
    } else {
        Write-Host "  [FAIL] Client executable still contains portal links!"
        $allPassed = $false
    }
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
