# Work Timer — IT Deployment & Operations Guide

This guide covers deployment, configuration, and routine administration of the Work Timer system across enterprise fleets (20 to 500+ machines).

---

## 1. Prerequisites

- **Workstations:** Windows 10, Windows 11, or Windows Server (x64 / ARM64).
- **PowerShell:** Built-in Windows PowerShell 5.1 (standard on all Windows 10/11 installations).
- **Permissions:** No administrative rights required on employee machines.
- **Central Storage:** Shared SMB/UNC folder (e.g. `\\server\worktime`), SharePoint Document Library, or Google Drive folder.

---

## 2. Directory Structure

```
Timechamp/
├── agent/
│   ├── agent.ps1           # Silent background time-tracker engine
│   ├── launcher.vbs        # Zero-console-window VBScript runner
│   ├── run-agent.bat       # Batch runner wrapper
│   └── config.default.json # Base configuration file
├── sync/
│   └── Sync-Transport.ps1  # Transport module (Option A Share, Option C Graph, Option B GDrive)
├── admin/
│   ├── admin-report.ps1    # Admin reporting script (Daily/Weekly/Monthly/Custom)
│   └── Export-XlsxNative.ps1 # Dependency-free OpenXML Excel (.xlsx) generator
├── deploy/
│   ├── install.ps1         # User-level installer (HKCU Run key or Scheduled Task)
│   ├── uninstall.ps1       # Clean uninstaller
│   └── deploy-fleet.ps1    # Automated GPO/Intune fleet deployment script
├── tests/
│   └── Run-Tests.ps1       # Master test suite runner
└── docs/
    ├── ARCHITECTURE.md     # Architectural reference
    ├── DEPLOYMENT.md       # This guide
    └── LEGAL_AND_POLICY.md # Legal compliance & employee notice template
```

---

## 3. Deployment Methods

### Method A: Single-Machine / Pilot Deployment (Manual)

To deploy on a test workstation:
```powershell
# From the repository root
powershell.exe -ExecutionPolicy Bypass -File .\deploy\install.ps1 `
    -CentralStorePath "\\server\worktime" `
    -Method "RunKey" `
    -IdleThresholdSeconds 600 `
    -StartNow
```

Verify installation:
```powershell
powershell.exe -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\WT\agent.ps1" -Status
```

---

### Method B: Active Directory Group Policy (GPO Logon Script)

For automatic deployment to 20–500 domain users:

1. Copy the `agent/` and `sync/` files to a read-only network share accessible by all domain users:
   `\\server\distribution\WorkTimer\`
2. Ensure the share contains:
   - `agent.ps1`
   - `launcher.vbs`
   - `run-agent.bat`
   - `Sync-Transport.ps1`
   - `deploy-fleet.ps1`
3. Open **Group Policy Management Console (gpmc.msc)**.
4. Edit the Target GPO applying to your workstation OU.
5. Navigate to:  
   `User Configuration` -> `Policies` -> `Windows Settings` -> `Scripts (Logon/Logoff)` -> `Logon`.
6. Select the **PowerShell Scripts** tab and add:
   - **Script Name:** `\\server\distribution\WorkTimer\deploy-fleet.ps1`
   - **Script Parameters:** `-DistributionShare "\\server\distribution\WorkTimer" -CentralStorePath "\\server\worktime"`
7. When users log in, `deploy-fleet.ps1` will copy files to `%LOCALAPPDATA%\WT\`, configure the `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` key, and launch the agent silently.

---

### Method C: Microsoft Intune

1. Package the repository folder (`agent/`, `sync/`, `deploy/`) into an `.intunewin` package or deploy as a **PowerShell Script** under **Devices -> Scripts**.
2. Set **Run this script using the logged on credentials**: `Yes` (User context).
3. Set **Enforce script signature check**: `No` (unless using internal code-signing certificate).
4. Set **Run script in 64-bit PowerShell Host**: `Yes`.

---

## 4. Setting Up Central Storage (Option A: SMB Share)

1. Create a folder on the central file server (e.g., `D:\WorkTimeShares`).
2. Share the folder as `\\server\worktime`.
3. Configure NTFS and Share permissions:
   - **Domain Users / Employees:** Grant **Modify / Write** permission (enables creating user subfolders and uploading daily CSVs).
   - **Managers / HR / Admins:** Grant **Read / Write** permission across all subfolders.

---

## 5. Running Admin Reports

Administrators generate reports on demand or on a scheduled basis.

### Daily Report
```powershell
powershell.exe -ExecutionPolicy Bypass -File .\admin\admin-report.ps1 `
    -ReportType Daily `
    -Date "2026-11-04" `
    -CentralStorePath "\\server\worktime" `
    -OutputDir ".\reports" `
    -Format both
```

### Weekly Report (ISO Week)
```powershell
powershell.exe -ExecutionPolicy Bypass -File .\admin\admin-report.ps1 `
    -ReportType Weekly `
    -Week "2026-W45" `
    -CentralStorePath "\\server\worktime" `
    -OutputDir ".\reports" `
    -Format both
```

### Monthly Report
```powershell
powershell.exe -ExecutionPolicy Bypass -File .\admin\admin-report.ps1 `
    -ReportType Monthly `
    -Month "2026-11" `
    -CentralStorePath "\\server\worktime" `
    -OutputDir ".\reports" `
    -Format both
```

### Custom Date Range (Filtered by User)
```powershell
powershell.exe -ExecutionPolicy Bypass -File .\admin\admin-report.ps1 `
    -ReportType Custom `
    -StartDate "2026-11-01" `
    -EndDate "2026-11-15" `
    -User "ravi.k" `
    -CentralStorePath "\\server\worktime" `
    -OutputDir ".\reports" `
    -Format both
```

---

## 6. Uninstallation & Removal

To cleanly uninstall the agent from an endpoint:
```powershell
powershell.exe -ExecutionPolicy Bypass -File .\deploy\uninstall.ps1 -RemoveData
```
This stops any running agent instances, deletes the HKCU Run key, and purges `%LOCALAPPDATA%\WT`.
