<#
.SYNOPSIS
    Unit Tests: Admin Reporting & Multi-Sheet OpenXML Export
#>

$testDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$rootDir = Split-Path -Parent $testDir
$reportScript = Join-Path (Join-Path $rootDir "admin") "admin-report.ps1"

$tempCentral = Join-Path $env:TEMP "wt_test_admin_central"
$tempReports = Join-Path $env:TEMP "wt_test_admin_reports"

if (Test-Path $tempCentral) { Remove-Item $tempCentral -Recurse -Force }
if (Test-Path $tempReports) { Remove-Item $tempReports -Recurse -Force }
New-Item -ItemType Directory -Path $tempCentral, $tempReports -Force | Out-Null

Write-Host "--- Running Test-AdminReport ---"
$allPassed = $true

# Create multi-user, multi-day records in Central Store
$u1Dir = Join-Path $tempCentral "ravi.k"
$u2Dir = Join-Path $tempCentral "meena.s"
New-Item -ItemType Directory -Path $u1Dir, $u2Dir -Force | Out-Null

# User 1: ravi.k (2 days)
$csvRavi1 = @"
date,user,machine,active_seconds,active_hms,idle_seconds,idle_hms,first_input_utc,last_input_utc,pause_count
2026-11-04,ravi.k,WS-14,28800,08:00:00,3600,01:00:00,2026-11-04T03:30:00Z,2026-11-04T12:30:00Z,3
"@
Set-Content -Path (Join-Path $u1Dir "daily_ravi.k_2026-11-04.csv") -Value $csvRavi1

$csvRavi2 = @"
date,user,machine,active_seconds,active_hms,idle_seconds,idle_hms,first_input_utc,last_input_utc,pause_count
2026-11-05,ravi.k,WS-14,27000,07:30:00,4200,01:10:00,2026-11-05T03:35:00Z,2026-11-05T12:25:00Z,4
"@
Set-Content -Path (Join-Path $u1Dir "daily_ravi.k_2026-11-05.csv") -Value $csvRavi2

# User 2: meena.s (1 day)
$csvMeena1 = @"
date,user,machine,active_seconds,active_hms,idle_seconds,idle_hms,first_input_utc,last_input_utc,pause_count
2026-11-04,meena.s,WS-22,29500,08:11:40,2400,00:40:00,2026-11-04T03:20:00Z,2026-11-04T12:15:00Z,2
"@
Set-Content -Path (Join-Path $u2Dir "daily_meena.s_2026-11-04.csv") -Value $csvMeena1

# 1. Test Daily Report
$resDaily = & $reportScript -ReportType Daily -Date "2026-11-04" -CentralStorePath $tempCentral -OutputDir $tempReports -Format both
$dailyXlsx = Join-Path $tempReports "report_daily_2026-11-04.xlsx"
$dailyCsv  = Join-Path $tempReports "report_daily_2026-11-04_summary.csv"

if ((Test-Path $dailyXlsx) -and (Test-Path $dailyCsv) -and $resDaily.UserCount -eq 2) {
    Write-Host "  [PASS] Daily report generated successfully (2 users, XLSX & CSV exist)."
} else {
    Write-Host "  [FAIL] Daily report generation failed."
    $allPassed = $false
}

# 2. Test Weekly Report
$resWeek = & $reportScript -ReportType Weekly -Date "2026-11-04" -CentralStorePath $tempCentral -OutputDir $tempReports -Format both
$weekXlsx = Join-Path $tempReports "report_week_2026-W45.xlsx"
$weekCsv  = Join-Path $tempReports "report_week_2026-W45_matrix.csv"

if ((Test-Path $weekXlsx) -and (Test-Path $weekCsv) -and $resWeek.TotalRecords -eq 3) {
    Write-Host "  [PASS] Weekly report generated successfully (3 records across week 45)."
} else {
    Write-Host "  [FAIL] Weekly report generation failed."
    $allPassed = $false
}

# 3. Test Monthly Report
$resMonth = & $reportScript -ReportType Monthly -Month "2026-11" -CentralStorePath $tempCentral -OutputDir $tempReports -Format both
$monthXlsx = Join-Path $tempReports "report_month_2026-11.xlsx"

if (Test-Path $monthXlsx) {
    Write-Host "  [PASS] Monthly report generated successfully."
} else {
    Write-Host "  [FAIL] Monthly report generation failed."
    $allPassed = $false
}

# 4. Test Custom Range Report with User Filter
$resCustom = & $reportScript -ReportType Custom -StartDate "2026-11-01" -EndDate "2026-11-07" -User "ravi.k" -CentralStorePath $tempCentral -OutputDir $tempReports -Format both
$customXlsx = Join-Path $tempReports "report_custom_2026-11-01_to_2026-11-07.xlsx"

if ((Test-Path $customXlsx) -and $resCustom.UserCount -eq 1 -and $resCustom.TotalRecords -eq 2) {
    Write-Host "  [PASS] Custom range with user filter: 1 user (ravi.k) with 2 records."
} else {
    Write-Host "  [FAIL] Custom range report failed: userCount=$($resCustom.UserCount), records=$($resCustom.TotalRecords)"
    $allPassed = $false
}

# 5. Verify OpenXML Internal Structure of Generated XLSX
Add-Type -AssemblyName System.IO.Compression.FileSystem
$unzipDir = Join-Path $env:TEMP "wt_test_xlsx_unzip"
if (Test-Path $unzipDir) { Remove-Item $unzipDir -Recurse -Force }
[System.IO.Compression.ZipFile]::ExtractToDirectory($weekXlsx, $unzipDir)

$hasSheet1 = Test-Path (Join-Path $unzipDir "xl\worksheets\sheet1.xml")
$hasSheet2 = Test-Path (Join-Path $unzipDir "xl\worksheets\sheet2.xml")
$hasSheet3 = Test-Path (Join-Path $unzipDir "xl\worksheets\sheet3.xml")
$hasStyles = Test-Path (Join-Path $unzipDir "xl\styles.xml")

if ($hasSheet1 -and $hasSheet2 -and $hasSheet3 -and $hasStyles) {
    Write-Host "  [PASS] OpenXML structure verified: 3 worksheets (Summary, Details, Matrix) + styles.xml present."
} else {
    Write-Host "  [FAIL] OpenXML structure missing required sheets or styles."
    $allPassed = $false
}

# Cleanup
Remove-Item $unzipDir -Recurse -Force
Remove-Item $tempCentral -Recurse -Force
Remove-Item $tempReports -Recurse -Force

if ($allPassed) {
    Write-Host "[RESULT] Test-AdminReport: ALL PASSED"
    exit 0
} else {
    Write-Host "[RESULT] Test-AdminReport: FAILURES DETECTED"
    exit 1
}
