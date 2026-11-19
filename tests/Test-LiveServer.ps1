<#
.SYNOPSIS
    Unit Tests: Vserve-TimeChamp Live Tracking Server & Configuration API
#>

$testDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$rootDir = Split-Path -Parent $testDir
$serverJs = Join-Path (Join-Path $rootDir "admin") "server.js"

Write-Host "--- Running Test-LiveServer ---"
$allPassed = $true

if (-not (Test-Path $serverJs)) {
    Write-Host "  [FAIL] server.js not found at $serverJs"
    exit 1
}

# Start server on test port 3099
$env:PORT = "3099"
$serverProc = Start-Process -FilePath "node" -ArgumentList "`"$serverJs`"" -PassThru
Start-Sleep -Seconds 2

try {
    # 1. Test Unauthenticated Access to Protected Configuration (Must return 401)
    try {
        Invoke-RestMethod -Uri "http://localhost:3099/api/config" -Method GET
        Write-Host "  [FAIL] Unauthenticated GET /api/config should have returned 401."
        $allPassed = $false
    } catch {
        if ($_.Exception.Response.StatusCode.value__ -eq 401) {
            Write-Host "  [PASS] Unauthenticated GET /api/config properly rejected with 401 Unauthorized."
        } else {
            Write-Host "  [FAIL] Expected 401 for unauthenticated config access, got $($_.Exception.Response.StatusCode.value__)"
            $allPassed = $false
        }
    }

    # 2. Administrator Login to obtain Admin Session Token
    $adminPayload = @{ username = "Samuel P" } | ConvertTo-Json
    $adminRes = Invoke-RestMethod -Uri "http://localhost:3099/api/admin/login" -Method POST -Body $adminPayload -ContentType "application/json"
    if ($adminRes.success -and $adminRes.token) {
        $adminToken = $adminRes.token
        Write-Host "  [PASS] POST /api/admin/login authenticated administrator 'Samuel P'."
    } else {
        Write-Host "  [FAIL] Administrator login failed."
        $allPassed = $false
    }

    $adminHeaders = @{ "X-Admin-Token" = $adminToken }

    # 3. Test GET /api/config with Admin Token
    $cfg = Invoke-RestMethod -Uri "http://localhost:3099/api/config" -Method GET -Headers $adminHeaders
    if ($cfg -and $cfg.agent -and $cfg.agent.idleThresholdSeconds) {
        Write-Host "  [PASS] GET /api/config returned valid configuration with Admin Token (IdleThreshold: $($cfg.agent.idleThresholdSeconds)s)"
    } else {
        Write-Host "  [FAIL] GET /api/config with Admin Token failed"
        $allPassed = $false
    }

    # 4. Test POST /api/heartbeat (Public for tracking clients)
    $hb = @{
        user = "test.agent"
        machine = "TEST-PC"
        status = "Active"
        activeSeconds = 3600
        idleSeconds = 300
        prodPct = 95
        currentApp = "code.exe"
        windowTitle = "Vserve-TimeChamp - Visual Studio Code"
        url = "https://github.com/solidtime-io/solidtime"
    } | ConvertTo-Json

    $postRes = Invoke-RestMethod -Uri "http://localhost:3099/api/heartbeat" -Method POST -Body $hb -ContentType "application/json"
    if ($postRes.status -eq "ok") {
        Write-Host "  [PASS] POST /api/heartbeat ingested live telemetry successfully."
    } else {
        Write-Host "  [FAIL] POST /api/heartbeat failed"
        $allPassed = $false
    }

    # 5. Test GET /api/live with Admin Token
    $live = Invoke-RestMethod -Uri "http://localhost:3099/api/live" -Method GET -Headers $adminHeaders
    $found = $live | Where-Object { $_.user -eq "test.agent" }
    if ($found -and $found.effectiveStatus -eq "Active" -and $found.currentApp -eq "code.exe") {
        Write-Host "  [PASS] GET /api/live reflected real-time employee status: $($found.effectiveStatus), App: $($found.currentApp)"
    } else {
        Write-Host "  [FAIL] GET /api/live did not reflect ingested user"
        $allPassed = $false
    }
}
finally {
    if ($serverProc -and -not $serverProc.HasExited) {
        Stop-Process -Id $serverProc.Id -Force -ErrorAction SilentlyContinue
    }
}

if ($allPassed) {
    Write-Host "[RESULT] Test-LiveServer: ALL PASSED"
    exit 0
} else {
    Write-Host "[RESULT] Test-LiveServer: SOME TESTS FAILED"
    exit 1
}
