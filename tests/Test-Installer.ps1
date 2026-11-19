<#
.SYNOPSIS
    Unit Tests: Installer & Uninstaller Idempotency & Clean Removal
#>

$testDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$rootDir = Split-Path -Parent $testDir
$installScript = Join-Path (Join-Path $rootDir "deploy") "install.ps1"
$uninstallScript = Join-Path (Join-Path $rootDir "deploy") "uninstall.ps1"

$tempInstallDir = Join-Path $env:TEMP "wt_test_install_dir"
if (Test-Path $tempInstallDir) { Remove-Item $tempInstallDir -Recurse -Force }

Write-Host "--- Running Test-Installer ---"
$allPassed = $true

# 1. Test Installation via RunKey
& $installScript -InstallDir $tempInstallDir -Method RunKey -CentralStorePath "\\server\testshare" -StartNow:$false

$hasAgent = Test-Path (Join-Path $tempInstallDir "agent.ps1")
$hasLauncher = Test-Path (Join-Path $tempInstallDir "launcher.vbs")
$hasConfig = Test-Path (Join-Path $tempInstallDir "config.json")
$hasSync = Test-Path (Join-Path $tempInstallDir "Sync-Transport.ps1")

$runKeyVal = (Get-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "WorkTimerAgent" -ErrorAction SilentlyContinue).WorkTimerAgent

if ($hasAgent -and $hasLauncher -and $hasConfig -and $hasSync -and (-not [string]::IsNullOrEmpty($runKeyVal))) {
    Write-Host "  [PASS] Installation succeeded: All files deployed and HKCU Run key registered."
} else {
    Write-Host "  [FAIL] Installation failed to deploy files or set Run key."
    $allPassed = $false
}

# 2. Test Uninstaller
& $uninstallScript -InstallDir $tempInstallDir -RemoveData

$runKeyAfter = (Get-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "WorkTimerAgent" -ErrorAction SilentlyContinue).WorkTimerAgent
$dirExistsAfter = Test-Path $tempInstallDir

if ([string]::IsNullOrEmpty($runKeyAfter) -and (-not $dirExistsAfter)) {
    Write-Host "  [PASS] Uninstallation succeeded: Run key removed and install directory wiped."
} else {
    Write-Host "  [FAIL] Uninstallation incomplete: RunKey=$runKeyAfter, DirExists=$dirExistsAfter"
    $allPassed = $false
}

if ($allPassed) {
    Write-Host "[RESULT] Test-Installer: ALL PASSED"
    exit 0
} else {
    Write-Host "[RESULT] Test-Installer: FAILURES DETECTED"
    exit 1
}
