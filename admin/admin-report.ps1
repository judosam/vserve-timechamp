<#
.SYNOPSIS
    Work Timer - Admin Reporting & Analytics Engine
.DESCRIPTION
    Scans the central store for user daily active-time CSVs, filters by Date/Week/Month/Custom range,
    aggregates metrics per user and across the fleet, and exports consolidated reports as .xlsx and .csv.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [ValidateSet("Daily", "Weekly", "Monthly", "Custom")]
    [string]$ReportType = "Daily",

    [Parameter(Mandatory = $false)]
    [string]$CentralStorePath,

    [Parameter(Mandatory = $false)]
    [string]$Date,

    [Parameter(Mandatory = $false)]
    [string]$Week,

    [Parameter(Mandatory = $false)]
    [string]$Month,

    [Parameter(Mandatory = $false)]
    [string]$StartDate,

    [Parameter(Mandatory = $false)]
    [string]$EndDate,

    [Parameter(Mandatory = $false)]
    [string]$User,

    [Parameter(Mandatory = $false)]
    [string]$OutputDir = ".\reports",

    [Parameter(Mandatory = $false)]
    [ValidateSet("both", "xlsx", "csv")]
    [string]$Format = "both",

    [Parameter(Mandatory = $false)]
    [string]$ConfigPath
)

# -------------------------------------------------------------------------
# Load Native XLSX Generator
# -------------------------------------------------------------------------
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
if ([string]::IsNullOrEmpty($scriptDir)) { $scriptDir = (Get-Location).Path }
$nativeXlsxPath = Join-Path $scriptDir "Export-XlsxNative.ps1"
if (Test-Path $nativeXlsxPath) {
    . $nativeXlsxPath
} else {
    Write-Warning "Export-XlsxNative.ps1 not found at $nativeXlsxPath"
}

# -------------------------------------------------------------------------
# Load Configuration (CentralStorePath fallback)
# -------------------------------------------------------------------------
if ([string]::IsNullOrEmpty($CentralStorePath)) {
    $searchConfigs = @(
        $ConfigPath,
        (Join-Path $scriptDir "config.json"),
        (Join-Path (Join-Path $scriptDir "..") "config.default.json"),
        (Join-Path (Join-Path $env:LOCALAPPDATA "WT") "config.json")
    )
    foreach ($cfg in $searchConfigs) {
        if (-not [string]::IsNullOrEmpty($cfg) -and (Test-Path $cfg)) {
            try {
                $rawCfg = Get-Content -Path $cfg -Raw | ConvertFrom-Json
                if ($rawCfg.sync.share.centralPath) {
                    $CentralStorePath = $rawCfg.sync.share.centralPath
                    break
                }
            } catch {}
        }
    }
}

if ([string]::IsNullOrEmpty($CentralStorePath)) {
    $CentralStorePath = "\\server\worktime"
}

$CentralStorePath = [System.Environment]::ExpandEnvironmentVariables($CentralStorePath)

# -------------------------------------------------------------------------
# Date Range Resolution
# -------------------------------------------------------------------------
$reportStartDate = $null
$reportEndDate = $null
$reportFileId = ""

switch ($ReportType) {
    "Daily" {
        $targetDateStr = if (-not [string]::IsNullOrEmpty($Date)) { $Date } else { [DateTime]::Now.ToString("yyyy-MM-dd") }
        $targetDate = [DateTime]::Parse($targetDateStr)
        $reportStartDate = $targetDate.Date
        $reportEndDate   = $targetDate.Date
        $reportFileId    = "daily_$targetDateStr"
    }

    "Weekly" {
        if (-not [string]::IsNullOrEmpty($Week) -and $Week -match '^(\d{4})-W?(\d{1,2})$') {
            $year = [int]$Matches[1]
            $weekNum = [int]$Matches[2]
            $jan4 = [DateTime]::new($year, 1, 4)
            $offset = if ([int]$jan4.DayOfWeek -eq 0) { 6 } else { [int]$jan4.DayOfWeek - 1 }
            $week1Mon = $jan4.AddDays(-$offset)
            $reportStartDate = $week1Mon.AddDays(($weekNum - 1) * 7).Date
            $reportEndDate   = $reportStartDate.AddDays(6).Date
            $reportFileId    = ("week_{0}-W{1:D2}" -f $year, $weekNum)
        } else {
            $baseDate = if (-not [string]::IsNullOrEmpty($Date)) { [DateTime]::Parse($Date) } else { [DateTime]::Now }
            $dayOfWeek = [int]$baseDate.DayOfWeek
            $offset = if ($dayOfWeek -eq 0) { 6 } else { $dayOfWeek - 1 }
            $reportStartDate = $baseDate.AddDays(-$offset).Date
            $reportEndDate   = $reportStartDate.AddDays(6).Date

            $cal = [System.Globalization.CultureInfo]::InvariantCulture.Calendar
            $weekNum = $cal.GetWeekOfYear($baseDate, [System.Globalization.CalendarWeekRule]::FirstFourDayWeek, [DayOfWeek]::Monday)
            $reportFileId = ("week_{0}-W{1:D2}" -f $baseDate.Year, $weekNum)
        }
    }

    "Monthly" {
        $monthStr = if (-not [string]::IsNullOrEmpty($Month)) { $Month }
                    elseif (-not [string]::IsNullOrEmpty($Date)) { $Date.Substring(0, 7) }
                    else { [DateTime]::Now.ToString("yyyy-MM") }

        $parsedMonth = [DateTime]::Parse("$monthStr-01")
        $reportStartDate = $parsedMonth.Date
        $reportEndDate   = $parsedMonth.AddMonths(1).AddDays(-1).Date
        $reportFileId    = "month_$monthStr"
    }

    "Custom" {
        if ([string]::IsNullOrEmpty($StartDate) -or [string]::IsNullOrEmpty($EndDate)) {
            throw "For ReportType 'Custom', both -StartDate and -EndDate (yyyy-MM-dd) are required."
        }
        $reportStartDate = [DateTime]::Parse($StartDate).Date
        $reportEndDate   = [DateTime]::Parse($EndDate).Date
        $reportFileId    = "custom_$($reportStartDate.ToString('yyyy-MM-dd'))_to_$($reportEndDate.ToString('yyyy-MM-dd'))"
    }
}

Write-Host "=== Work Timer Admin Reporting ==="
Write-Host "Report Type:   $ReportType"
Write-Host "Date Range:    $($reportStartDate.ToString('yyyy-MM-dd')) to $($reportEndDate.ToString('yyyy-MM-dd'))"
Write-Host "Central Store: $CentralStorePath"
if (-not [string]::IsNullOrEmpty($User)) {
    Write-Host "User Filter:   $User"
}

# -------------------------------------------------------------------------
# Scan Central Store for Daily CSVs
# -------------------------------------------------------------------------
if (-not (Test-Path $CentralStorePath)) {
    Write-Warning "Central store path does not exist or is unreachable: $CentralStorePath"
    return
}

$csvFiles = Get-ChildItem -Path $CentralStorePath -Filter "daily_*.csv" -Recurse -File
Write-Host "Found $($csvFiles.Count) CSV files in central store."

$rawRecords = @()
foreach ($file in $csvFiles) {
    try {
        $rows = Import-Csv -Path $file.FullName
        foreach ($r in $rows) {
            if (-not $r.date -or -not $r.user) { continue }
            $rDate = [DateTime]::Parse($r.date).Date
            if ($rDate -ge $reportStartDate -and $rDate -le $reportEndDate) {
                if ([string]::IsNullOrEmpty($User) -or $User -eq "*" -or $r.user -ieq $User) {
                    $rawRecords += $r
                }
            }
        }
    }
    catch {
        Write-Warning "Failed to read CSV $($file.FullName): $($_.Exception.Message)"
    }
}

Write-Host "Matching day records in date range: $($rawRecords.Count)"
if ($rawRecords.Count -eq 0) {
    Write-Warning "No records found matching criteria in date range $($reportStartDate.ToString('yyyy-MM-dd')) to $($reportEndDate.ToString('yyyy-MM-dd'))."
    return
}

# Helper to format duration HMS
function Format-AdminHMS([int64]$sec) {
    if ($sec -lt 0) { $sec = 0 }
    $h = [math]::Floor($sec / 3600)
    $m = [math]::Floor(($sec % 3600) / 60)
    $s = $sec % 60
    return ("{0:D2}:{1:D2}:{2:D2}" -f [int]$h, [int]$m, [int]$s)
}

# -------------------------------------------------------------------------
# Aggregation: Summary & Details
# -------------------------------------------------------------------------
$groupedByUser = $rawRecords | Group-Object -Property user | Sort-Object Name

$summaryRows = @()
$fleetTotalActiveSec = [int64]0
$fleetTotalIdleSec = [int64]0
$fleetTotalPauses = 0
$fleetTotalDays = 0

foreach ($grp in $groupedByUser) {
    $u = $grp.Name
    $userRecords = $grp.Group

    $userActiveSec = [int64]0
    $userIdleSec = [int64]0
    $userPauses = 0
    $uniqueDays = @{}
    $machines = @{}

    foreach ($rec in $userRecords) {
        $aSec = [int64]$(if ($rec.active_seconds) { $rec.active_seconds } else { 0 })
        $iSec = [int64]$(if ($rec.idle_seconds) { $rec.idle_seconds } else { 0 })
        $pCnt = [int]$(if ($rec.pause_count) { $rec.pause_count } else { 0 })

        $userActiveSec += $aSec
        $userIdleSec += $iSec
        $userPauses += $pCnt

        if ($aSec -gt 0) { $uniqueDays[$rec.date] = $true }
        if ($rec.machine) { $machines[$rec.machine] = $true }
    }

    $daysActive = [math]::Max($uniqueDays.Keys.Count, 1)
    $avgActiveHours = [math]::Round(($userActiveSec / 3600.0) / $daysActive, 2)
    $totalActiveHours = [math]::Round($userActiveSec / 3600.0, 2)
    $totalIdleHours = [math]::Round($userIdleSec / 3600.0, 2)

    $fleetTotalActiveSec += $userActiveSec
    $fleetTotalIdleSec += $userIdleSec
    $fleetTotalPauses += $userPauses
    $fleetTotalDays += $uniqueDays.Keys.Count

    $summaryRows += [PSCustomObject]@{
        "User"                      = $u
        "Days Active"               = $uniqueDays.Keys.Count
        "Total Active Time"         = Format-AdminHMS $userActiveSec
        "Total Active Hours"        = $totalActiveHours
        "Total Idle Time"           = Format-AdminHMS $userIdleSec
        "Total Idle Hours"          = $totalIdleHours
        "Avg Daily Active Hours"    = $avgActiveHours
        "Total Pauses"              = $userPauses
        "Machines"                  = ($machines.Keys -join ", ")
    }
}

# Summary Totals Row
$fleetActiveHours = [math]::Round($fleetTotalActiveSec / 3600.0, 2)
$fleetIdleHours   = [math]::Round($fleetTotalIdleSec / 3600.0, 2)
$fleetAvgDaily    = if ($summaryRows.Count -gt 0) {
    [math]::Round(($fleetTotalActiveSec / 3600.0) / [math]::Max($fleetTotalDays, 1), 2)
} else { 0.0 }

$fleetSummaryRow = [PSCustomObject]@{
    "User"                   = "TOTAL / FLEET"
    "Days Active"            = $fleetTotalDays
    "Total Active Time"      = Format-AdminHMS $fleetTotalActiveSec
    "Total Active Hours"     = $fleetActiveHours
    "Total Idle Time"        = Format-AdminHMS $fleetTotalIdleSec
    "Total Idle Hours"       = $fleetIdleHours
    "Avg Daily Active Hours" = $fleetAvgDaily
    "Total Pauses"           = $fleetTotalPauses
    "Machines"               = ""
}

# -------------------------------------------------------------------------
# Daily Details List
# -------------------------------------------------------------------------
$detailRows = @()
$sortedRecords = $rawRecords | Sort-Object { [DateTime]::Parse($_.date) }, user

foreach ($rec in $sortedRecords) {
    $aSec = [int64]$(if ($rec.active_seconds) { $rec.active_seconds } else { 0 })
    $iSec = [int64]$(if ($rec.idle_seconds) { $rec.idle_seconds } else { 0 })
    $pCnt = [int]$(if ($rec.pause_count) { $rec.pause_count } else { 0 })

    $detailRows += [PSCustomObject]@{
        "Date"             = $rec.date
        "User"             = $rec.user
        "Machine"          = $rec.machine
        "Active Time"      = Format-AdminHMS $aSec
        "Active Hours"     = [math]::Round($aSec / 3600.0, 2)
        "Idle Time"        = Format-AdminHMS $iSec
        "Idle Hours"       = [math]::Round($iSec / 3600.0, 2)
        "First Input (UTC)"= $rec.first_input_utc
        "Last Input (UTC)" = $rec.last_input_utc
        "Pause Count"      = $pCnt
    }
}

# -------------------------------------------------------------------------
# Matrix (Pivot: Users x Dates)
# -------------------------------------------------------------------------
# Collect all distinct dates in range
$distinctDates = @()
$currD = $reportStartDate
while ($currD -le $reportEndDate) {
    $distinctDates += $currD.ToString("yyyy-MM-dd")
    $currD = $currD.AddDays(1)
}

$matrixColumns = @("User") + $distinctDates + @("Total Active Time", "Total Active Hours")
$matrixRows = @()
$dateTotalsSec = @{}
foreach ($d in $distinctDates) { $dateTotalsSec[$d] = [int64]0 }

foreach ($grp in $groupedByUser) {
    $u = $grp.Name
    $rowMap = [ordered]@{}
    $rowMap["User"] = $u
    $uTotalSec = [int64]0

    # Build date lookup
    $userDateSec = @{}
    foreach ($r in $grp.Group) {
        $userDateSec[$r.date] = [int64]$(if ($r.active_seconds) { $r.active_seconds } else { 0 })
    }

    foreach ($d in $distinctDates) {
        $sec = if ($userDateSec.ContainsKey($d)) { $userDateSec[$d] } else { [int64]0 }
        $uTotalSec += $sec
        $dateTotalsSec[$d] += $sec
        $rowMap[$d] = if ($sec -gt 0) { Format-AdminHMS $sec } else { "-" }
    }

    $rowMap["Total Active Time"]  = Format-AdminHMS $uTotalSec
    $rowMap["Total Active Hours"] = [math]::Round($uTotalSec / 3600.0, 2)
    $matrixRows += [PSCustomObject]$rowMap
}

# Matrix Summary Row
$matrixSummaryMap = [ordered]@{}
$matrixSummaryMap["User"] = "DATE TOTAL (HOURS)"
$totalRangeSec = [int64]0
foreach ($d in $distinctDates) {
    $dSec = $dateTotalsSec[$d]
    $totalRangeSec += $dSec
    $matrixSummaryMap[$d] = [math]::Round($dSec / 3600.0, 2)
}
$matrixSummaryMap["Total Active Time"]  = Format-AdminHMS $totalRangeSec
$matrixSummaryMap["Total Active Hours"] = [math]::Round($totalRangeSec / 3600.0, 2)
$matrixSummaryRow = [PSCustomObject]$matrixSummaryMap

# -------------------------------------------------------------------------
# Output Export: CSV and XLSX
# -------------------------------------------------------------------------
if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}

$baseFileName = "report_$reportFileId"
$csvSummaryPath = Join-Path $OutputDir "${baseFileName}_summary.csv"
$csvDetailsPath = Join-Path $OutputDir "${baseFileName}_details.csv"
$csvMatrixPath  = Join-Path $OutputDir "${baseFileName}_matrix.csv"
$xlsxPath       = Join-Path $OutputDir "${baseFileName}.xlsx"

if ($Format -eq "csv" -or $Format -eq "both") {
    $summaryRows | Export-Csv -Path $csvSummaryPath -NoTypeInformation -Encoding UTF8
    $detailRows  | Export-Csv -Path $csvDetailsPath -NoTypeInformation -Encoding UTF8
    $matrixRows  | Export-Csv -Path $csvMatrixPath  -NoTypeInformation -Encoding UTF8
    Write-Host "Exported CSVs:"
    Write-Host "  Summary: $csvSummaryPath"
    Write-Host "  Details: $csvDetailsPath"
    Write-Host "  Matrix:  $csvMatrixPath"
}

if ($Format -eq "xlsx" -or $Format -eq "both") {
    $summaryCols = @("User", "Days Active", "Total Active Time", "Total Active Hours", "Total Idle Time", "Total Idle Hours", "Avg Daily Active Hours", "Total Pauses", "Machines")
    $detailCols  = @("Date", "User", "Machine", "Active Time", "Active Hours", "Idle Time", "Idle Hours", "First Input (UTC)", "Last Input (UTC)", "Pause Count")

    $sheets = @(
        @{
            Name       = "Summary"
            Columns    = $summaryCols
            Rows       = $summaryRows
            SummaryRow = $fleetSummaryRow
        },
        @{
            Name       = "Daily Details"
            Columns    = $detailCols
            Rows       = $detailRows
            SummaryRow = $null
        },
        @{
            Name       = "Active Time Matrix"
            Columns    = $matrixColumns
            Rows       = $matrixRows
            SummaryRow = $matrixSummaryRow
        }
    )

    Export-OpenXmlWorkbook -Sheets $sheets -OutputPath $xlsxPath | Out-Null
    Write-Host "Exported Excel:"
    Write-Host "  Workbook: $xlsxPath"
}

Write-Host "=== Reporting Complete ==="
return [PSCustomObject]@{
    ReportType   = $ReportType
    DateRange    = "$($reportStartDate.ToString('yyyy-MM-dd')) to $($reportEndDate.ToString('yyyy-MM-dd'))"
    UserCount    = $summaryRows.Count
    TotalRecords = $detailRows.Count
    XlsxPath     = $xlsxPath
    SummaryCsv   = $csvSummaryPath
}
