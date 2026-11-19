<#
.SYNOPSIS
    Zero-Dependency Native OpenXML Excel (.xlsx) Exporter for PowerShell 5.1 / .NET 4.5+
    Generates fully formatted multi-sheet Excel workbooks with styled headers, alternating row fills,
    freeze panes, auto-fit column widths, borders, and number alignments without requiring Excel
    or any external third-party PowerShell modules.
#>

function Get-ExcelColumnName {
    param([int]$colNumber)
    $dividend = $colNumber
    $colName = ""
    while ($dividend -gt 0) {
        $modulo = [int](($dividend - 1) % 26)
        $colName = [char](65 + $modulo) + $colName
        $dividend = [int][math]::Floor(($dividend - $modulo) / 26)
    }
    return $colName
}

function Escape-XmlText {
    param([string]$text)
    if ([string]::IsNullOrEmpty($text)) { return "" }
    return $text.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace('"', "&quot;").Replace("'", "&apos;")
}

function Export-OpenXmlWorkbook {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [array]$Sheets,

        [Parameter(Mandatory = $true)]
        [string]$OutputPath
    )

    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem

    $parentDir = Split-Path -Path $OutputPath -Parent
    if (-not [string]::IsNullOrEmpty($parentDir) -and -not (Test-Path $parentDir)) {
        New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
    }

    if (Test-Path $OutputPath) {
        Remove-Item -Path $OutputPath -Force
    }

    $zipStream = [System.IO.File]::Open($OutputPath, [System.IO.FileMode]::Create)
    $zip = New-Object System.IO.Compression.ZipArchive($zipStream, [System.IO.Compression.ZipArchiveMode]::Create)

    function Write-ZipStringEntry([string]$entryPath, [string]$content) {
        $entry = $zip.CreateEntry($entryPath)
        $writer = New-Object System.IO.StreamWriter($entry.Open(), [System.Text.Encoding]::UTF8)
        $writer.Write($content)
        $writer.Flush()
        $writer.Close()
    }

    # 1. [Content_Types].xml
    $sbContentTypes = New-Object System.Text.StringBuilder
    [void]$sbContentTypes.Append('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>')
    [void]$sbContentTypes.Append('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">')
    [void]$sbContentTypes.Append('<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>')
    [void]$sbContentTypes.Append('<Default Extension="xml" ContentType="application/xml"/>')
    [void]$sbContentTypes.Append('<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>')
    [void]$sbContentTypes.Append('<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>')

    for ($i = 1; $i -le $Sheets.Count; $i++) {
        [void]$sbContentTypes.Append(("<Override PartName=""/xl/worksheets/sheet{0}.xml"" ContentType=""application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml""/>" -f $i))
    }
    [void]$sbContentTypes.Append('</Types>')
    Write-ZipStringEntry "[Content_Types].xml" $sbContentTypes.ToString()

    # 2. _rels/.rels
    $relsXml = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>
'@
    Write-ZipStringEntry "_rels/.rels" $relsXml

    # 3. xl/_rels/workbook.xml.rels
    $sbWbRels = New-Object System.Text.StringBuilder
    [void]$sbWbRels.Append('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>')
    [void]$sbWbRels.Append('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">')
    for ($i = 1; $i -le $Sheets.Count; $i++) {
        [void]$sbWbRels.Append(("<Relationship Id=""rId{0}"" Type=""http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"" Target=""worksheets/sheet{0}.xml""/>" -f $i))
    }
    $stylesRelId = "rId$($Sheets.Count + 1)"
    [void]$sbWbRels.Append(("<Relationship Id=""{0}"" Type=""http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"" Target=""styles.xml""/>" -f $stylesRelId))
    [void]$sbWbRels.Append('</Relationships>')
    Write-ZipStringEntry "xl/_rels/workbook.xml.rels" $sbWbRels.ToString()

    # 4. xl/workbook.xml
    $sbWb = New-Object System.Text.StringBuilder
    [void]$sbWb.Append('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>')
    [void]$sbWb.Append('<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">')
    [void]$sbWb.Append('<sheets>')
    for ($i = 1; $i -le $Sheets.Count; $i++) {
        $sheetObj = $Sheets[$i - 1]
        $sheetName = Escape-XmlText $sheetObj.Name
        if ([string]::IsNullOrEmpty($sheetName)) { $sheetName = "Sheet$i" }
        [void]$sbWb.Append(("<sheet name=""{0}"" sheetId=""{1}"" r:id=""rId{1}""/>" -f $sheetName, $i))
    }
    [void]$sbWb.Append('</sheets>')
    [void]$sbWb.Append('</workbook>')
    Write-ZipStringEntry "xl/workbook.xml" $sbWb.ToString()

    # 5. xl/styles.xml
    # Style definitions:
    # Font 0: regular, Font 1: header bold white, Font 2: summary bold dark
    # Fill 0: none, Fill 1: gray125, Fill 2: Navy Header (#1F4E79), Fill 3: Alternating (#F2F4F7), Fill 4: Summary (#D9E1F2)
    # Border 0: none, Border 1: thin light-gray (#D9D9D9), Border 2: summary top-thin double-bottom
    # CellXfs:
    # 0: Text regular left
    # 1: Number regular right
    # 2: Text alt-row left
    # 3: Number alt-row right
    # 4: Header cell bold white navy-fill centered
    # 5: Summary text bold
    # 6: Summary number bold
    $stylesXml = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="3">
    <font><name val="Calibri"/><sz val="11"/></font>
    <font><b/><color rgb="FFFFFFFF"/><name val="Calibri"/><sz val="11"/></font>
    <font><b/><color rgb="FF1F2937"/><name val="Calibri"/><sz val="11"/></font>
  </fonts>
  <fills count="5">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF1F4E79"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF8FAFC"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFE2E8F0"/></patternFill></fill>
  </fills>
  <borders count="3">
    <border><left/><right/><top/><bottom/></border>
    <border>
      <left style="thin"><color rgb="FFE2E8F0"/></left>
      <right style="thin"><color rgb="FFE2E8F0"/></right>
      <top style="thin"><color rgb="FFE2E8F0"/></top>
      <bottom style="thin"><color rgb="FFE2E8F0"/></bottom>
    </border>
    <border>
      <left style="thin"><color rgb="FFCBD5E1"/></left>
      <right style="thin"><color rgb="FFCBD5E1"/></right>
      <top style="thin"><color rgb="FF475569"/></top>
      <bottom style="double"><color rgb="FF475569"/></bottom>
    </border>
  </borders>
  <cellStyleXfs count="1"><xf/></cellStyleXfs>
  <cellXfs count="7">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="4" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="4" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment horizontal="right" vertical="center"/></xf>
  </cellXfs>
</styleSheet>
'@
    Write-ZipStringEntry "xl/styles.xml" $stylesXml

    # 6. xl/worksheets/sheet<N>.xml
    for ($i = 1; $i -le $Sheets.Count; $i++) {
        $sheetObj = $Sheets[$i - 1]
        $columns = $sheetObj.Columns
        $rows = $sheetObj.Rows
        $summaryRow = $sheetObj.SummaryRow

        # Calculate column widths
        $colWidths = @{}
        for ($c = 1; $c -le $columns.Count; $c++) {
            $colHeader = [string]$columns[$c - 1]
            $maxLen = $colHeader.Length
            if ($rows) {
                foreach ($r in $rows) {
                    $val = if ($r -is [hashtable]) { [string]$r[$colHeader] }
                           elseif ($r -is [PSCustomObject]) { [string]$r.$colHeader }
                           elseif ($r -is [array] -and ($c - 1) -lt $r.Count) { [string]$r[$c - 1] }
                           else { "" }
                    if ($val.Length -gt $maxLen) { $maxLen = $val.Length }
                }
            }
            $width = [math]::Max([math]::Min($maxLen + 4, 45), 12)
            $colWidths[$c] = $width
        }

        $sbSheet = New-Object System.Text.StringBuilder
        [void]$sbSheet.Append('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>')
        [void]$sbSheet.Append('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">')
        [void]$sbSheet.Append('<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>')

        # Column widths
        [void]$sbSheet.Append('<cols>')
        for ($c = 1; $c -le $columns.Count; $c++) {
            [void]$sbSheet.Append(("<col min=""{0}"" max=""{0}"" width=""{1}"" customWidth=""1""/>" -f $c, $colWidths[$c]))
        }
        [void]$sbSheet.Append('</cols>')

        [void]$sbSheet.Append('<sheetData>')

        # Header Row (Row 1)
        [void]$sbSheet.Append('<row r="1" ht="25" customHeight="1">')
        for ($c = 1; $c -le $columns.Count; $c++) {
            $colName = Get-ExcelColumnName $c
            $cellRef = "$colName`1"
            $hdrText = Escape-XmlText ([string]$columns[$c - 1])
            [void]$sbSheet.Append(("<c r=""{0}"" s=""4"" t=""inlineStr""><is><t>{1}</t></is></c>" -f $cellRef, $hdrText))
        }
        [void]$sbSheet.Append('</row>')

        # Data Rows
        $rowNum = 2
        if ($rows) {
            foreach ($row in $rows) {
                $isAlt = ($rowNum % 2 -eq 1)
                $textStyle = if ($isAlt) { 2 } else { 0 }
                $numStyle  = if ($isAlt) { 3 } else { 1 }

                [void]$sbSheet.Append(("<row r=""{0}"" ht=""20"" customHeight=""1"">" -f $rowNum))
                for ($c = 1; $c -le $columns.Count; $c++) {
                    $colName = Get-ExcelColumnName $c
                    $cellRef = "$colName$rowNum"
                    $colHeader = [string]$columns[$c - 1]

                    $rawVal = if ($row -is [hashtable]) { $row[$colHeader] }
                              elseif ($row -is [PSCustomObject]) { $row.$colHeader }
                              elseif ($row -is [array] -and ($c - 1) -lt $row.Count) { $row[$c - 1] }
                              else { "" }

                    $valStr = [string]$rawVal

                    # Check if numeric (double or int, but not dates or times containing ':')
                    $isNum = $false
                    $numVal = 0.0
                    if ($valStr -notmatch '[:\-]' -and [double]::TryParse($valStr, [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$numVal)) {
                        $isNum = $true
                    }

                    if ($isNum) {
                        [void]$sbSheet.Append(("<c r=""{0}"" s=""{1}""><v>{2}</v></c>" -f $cellRef, $numStyle, $valStr))
                    } else {
                        $escaped = Escape-XmlText $valStr
                        [void]$sbSheet.Append(("<c r=""{0}"" s=""{1}"" t=""inlineStr""><is><t>{2}</t></is></c>" -f $cellRef, $textStyle, $escaped))
                    }
                }
                [void]$sbSheet.Append('</row>')
                $rowNum++
            }
        }

        # Summary Row (if specified)
        if ($summaryRow) {
            [void]$sbSheet.Append(("<row r=""{0}"" ht=""22"" customHeight=""1"">" -f $rowNum))
            for ($c = 1; $c -le $columns.Count; $c++) {
                $colName = Get-ExcelColumnName $c
                $cellRef = "$colName$rowNum"
                $colHeader = [string]$columns[$c - 1]

                $rawVal = if ($summaryRow -is [hashtable]) { $summaryRow[$colHeader] }
                          elseif ($summaryRow -is [PSCustomObject]) { $summaryRow.$colHeader }
                          elseif ($summaryRow -is [array] -and ($c - 1) -lt $summaryRow.Count) { $summaryRow[$c - 1] }
                          else { "" }

                $valStr = [string]$rawVal
                $isNum = $false
                $numVal = 0.0
                if ($valStr -notmatch '[:\-]' -and [double]::TryParse($valStr, [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$numVal)) {
                    $isNum = $true
                }

                if ($isNum) {
                    [void]$sbSheet.Append(("<c r=""{0}"" s=""6""><v>{1}</v></c>" -f $cellRef, $valStr))
                } else {
                    $escaped = Escape-XmlText $valStr
                    [void]$sbSheet.Append(("<c r=""{0}"" s=""5"" t=""inlineStr""><is><t>{1}</t></is></c>" -f $cellRef, $escaped))
                }
            }
            [void]$sbSheet.Append('</row>')
        }

        [void]$sbSheet.Append('</sheetData>')
        [void]$sbSheet.Append('</worksheet>')

        Write-ZipStringEntry "xl/worksheets/sheet$i.xml" $sbSheet.ToString()
    }

    $zip.Dispose()
    $zipStream.Dispose()

    return $OutputPath
}
