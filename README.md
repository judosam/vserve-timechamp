# Vserve-TimeChamp — Lightweight Windows Workforce & Active-Time Tracker

A production-grade, zero-dependency, silent background active-time tracker and productivity analytics solution replicating TimeChamp's core client capabilities natively for Windows using PowerShell 5.1, .NET, Win32 P/Invoke, and UI Automation.

Designed for fleets of 20 to 500+ employees. Requires **no administrative privileges**, **no third-party runtime installs**, and produces **zero UI distractions**.

---

## 1-Click Quick Deployment (Single Machine or Fleet)

### Method 1: Standalone Single Executable with Popup Widget (`vserve-timechamp-setup.exe`)
Simply double-click **`vserve-timechamp-setup.exe`** on any employee machine:
- **No external runtimes needed** (zero Node.js, zero Python, zero third-party dependencies required on client).
- **Self-Installs & Auto-Starts:** Drops payload to `%LOCALAPPDATA%\VserveTimeChamp\` and registers auto-start in `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`.
- **Interactive Popup Experience:**
  1. **Login Menu:** Employee selects or enters their username created by the admin in the Admin Portal.
  2. **Minimal Tracking Widget:** Once authenticated, switches to a sleek desktop floating card showing:
     - Real-time digital stopwatch timer (`HH:MM:SS`) ticking live.
     - Live Tracking Status badge (`● ACTIVE` in emerald green, `⏸️ PAUSED` in amber, `💤 IDLE` in orange).
     - Focused application and window title (`code.exe — server.js`) with productivity classification tag.
     - Today's shift summary (Active work time, away/idle time, productivity %).
     - Controls: Pause / Resume tracking, Open Admin Portal in browser, Hide to System Tray, Switch User.
  3. **System Tray Integration:** Minimizing or closing the window parks it in the Windows notification tray with hover tooltips and right-click menu (`Show Tracker`, `Pause/Resume`, `Open Portal`, `Sign Out`, `Exit`).
- To run silently in automated fleet deployments without UI: run with `--silent` or `/silent`.
- To cleanly uninstall: double-click **`vserve-timechamp-uninstall.exe`**.

### Method 2: Batch Launcher
Double-click **`install.bat`** (or `uninstall.bat` to remove).

---

## Live Dashboard & Admin Portal

Launch the visual workforce analytics server:
```cmd
start-dashboard.bat
```
Or run directly:
```cmd
node admin/server.js
```
Open **`http://localhost:3000`** to access:
1. **🟢 Live Workforce Pulse:** Real-time pulse cards showing active employees, currently focused application, active browser URL, live ticking timer, and productivity meters.
2. **📊 Web & App Analytics:** Complete breakdown of all desktop applications and browser websites visited with duration, percentage bars, and classification.
3. **⏱️ Shift Timesheets:** Consolidated daily work logs with one-click CSV and Excel export.
4. **👤 Employee Directory & User Management:** Create new employee login accounts, assign workstations, configure custom idle thresholds, toggle screenshot auditing, and dispatch global fleet policies. Newly created users can immediately log into the single executable.
5. **⬇️ 1-Click Download:** Download `vserve-timechamp-setup.exe` directly from the dashboard header (`/download/vserve-timechamp-setup.exe`).

---

## Key Features & Reverse-Engineered Capabilities

- **Accurate Active-Time Primitive:** Uses the Win32 `GetLastInputInfo` API with unsigned 32-bit tick arithmetic to measure active time without invasive keylogging.
- **Application & Active Window Tracking:** Replicates TimeChamp's `WindowsProcessUsageTracker` via Win32 `GetForegroundWindow` and `QueryFullProcessImageName` to track active process names (`code.exe`, `excel.exe`, `chrome.exe`) and window titles.
- **Extension-Less Browser URL Tracking:** Replicates TimeChamp's `UiAutomationElementPathFinder` using Windows UI Automation (`UIAutomationClient`) to read the address bar of Google Chrome, Microsoft Edge, and Brave without browser extensions.
- **Productivity Classification:** Automatically classifies activities into **Productive**, **Unproductive**, and **Neutral** based on configurable regex rules.
- **Always-On Watchdog Service:** Replicates TimeChamp's `Aos.TimeChamp.exe` watchdog (`vserve-watchdog.ps1` + `launcher-watchdog.vbs`) to automatically kick-start the agent if terminated or closed unexpectedly.
- **Monotonic & Crash-Proof Persistence:** Records running state every 30 seconds atomically (`.tmp` -> rename) to `%LOCALAPPDATA%\VserveTimeChamp\`. Resumes uninterrupted across machine crashes, logoffs, and reboots.
- **Zero-Window Silent Execution:** Launched via WScript shims (`SW_HIDE = 0`) to guarantee zero console window flash on logon.
- **Optional Periodic Screenshots:** Multi-monitor GDI+ screen capture (`System.Drawing.Graphics.CopyFromScreen`) with privacy blur filter.
- **Multi-Transport Central Sync:**
  - **Option A (Default):** Automated push to central SMB/UNC network share (`\\server\worktime\<user>\daily_<user>_<date>.csv`) with offline tolerance and backlog catchup.
  - **Option C:** Direct upload to Microsoft 365 SharePoint / OneDrive via Microsoft Graph API.
  - **Option B:** Google Drive API upload support.
- **Zero-Dependency Admin Reporting & OpenXML Engine:** Generates Daily, Weekly (ISO Wxx), Monthly, and Custom Range consolidated reports with multi-sheet styled Excel workbooks (`.xlsx`) using native .NET `ZipArchive`.
- **Interactive Workforce Web Dashboard:** Modern visual dashboard (`admin/dashboard/index.html`) displaying employee shift ratios, productivity scores, app/web usage charts, and export tools.
- **Automated Test Suite:** 8 complete test suites covering idle detection, state persistence, transitions, sync transport, reporting, installer, activity tracking, and the watchdog service.

---

## Directory Overview

```
Timechamp/
├── agent/
│   ├── agent.ps1                   # Main Vserve-TimeChamp background tracker agent
│   ├── Vserve-ActivityTracker.ps1   # Window & UI Automation browser URL tracking engine
│   ├── vserve-watchdog.ps1         # Always-On Watchdog keeper (Aos replica)
│   ├── launcher.vbs                # VBScript silent zero-window launcher shim
│   ├── launcher-watchdog.vbs       # VBScript silent watchdog launcher shim
│   ├── run-agent.bat               # Batch runner wrapper
│   └── config.default.json         # Default agent configuration template
├── sync/
│   └── Sync-Transport.ps1          # Multi-transport sync engine (Share, Graph, GDrive)
├── admin/
│   ├── admin-report.ps1            # Admin reporting & aggregation script
│   ├── Export-XlsxNative.ps1       # Native OpenXML multi-sheet Excel generator
│   └── dashboard/
│       └── index.html              # Interactive workforce & productivity web dashboard
├── deploy/
│   ├── install.ps1                 # User-level installer (HKCU Run key or Scheduled Task)
│   ├── uninstall.ps1               # Uninstaller
│   └── deploy-fleet.ps1            # Fleet logon script for GPO / Intune
├── tests/
│   ├── Run-Tests.ps1               # Master automated test suite runner
│   ├── Test-IdleDetector.ps1
│   ├── Test-StatePersistence.ps1
│   ├── Test-AccumulationLogic.ps1
│   ├── Test-SyncTransport.ps1
│   ├── Test-AdminReport.ps1
│   ├── Test-Installer.ps1
│   ├── Test-VserveActivityTracker.ps1
│   └── Test-VserveWatchdog.ps1
└── docs/
    ├── ARCHITECTURE.md             # Complete architecture specification
    ├── DEPLOYMENT.md               # Step-by-step IT operations manual
    └── LEGAL_AND_POLICY.md         # DPDP / GDPR legal compliance & notice template
```

---

## Quickstart

### 1. Install & Start Agent (Employee Machine)
```powershell
# Installs to %LOCALAPPDATA%\VserveTimeChamp\ and registers HKCU Run key for logon auto-start
powershell.exe -ExecutionPolicy Bypass -File .\deploy\install.ps1 `
    -CentralStorePath "\\server\worktime" `
    -StartNow
```

### 2. Check Agent & Watchdog Status
```powershell
powershell.exe -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\VserveTimeChamp\agent.ps1" -Status
```

Output:
```
==========================================================
             Vserve-TimeChamp Status & Summary            
==========================================================
User:             ravi.k
Machine:          WS-14
Local Directory:  C:\Users\ravi.k\AppData\Local\VserveTimeChamp

--- Shift Totals for 2026-11-19 ---
Status:           active
Active Time:      07:45:00 (27900s)
Idle Time:        00:45:00 (2700s)
Pauses Count:     3
Productive Time:  07:05:00 (91.4%)
Unproductive:     00:20:00
First Input:      2026-11-19T03:30:10Z
Last Input:       2026-11-19T12:00:10Z

--- Top Applications ---
  code.exe                 04:30:00 (Productive)
  chrome.exe               02:15:00 (Productive)
  teams.exe                01:00:00 (Productive)

--- Service Health ---
Agent Process:    RUNNING (PID: 8432)
Watchdog Process: RUNNING (PID: 4416)
==========================================================
```

### 3. Generate Admin Reports (Manager / HR)

#### Daily Report
```powershell
powershell.exe -ExecutionPolicy Bypass -File .\admin\admin-report.ps1 `
    -ReportType Daily `
    -Date "2026-11-19" `
    -CentralStorePath "\\server\worktime" `
    -OutputDir ".\reports"
```

#### Weekly Report (Monday–Sunday)
```powershell
powershell.exe -ExecutionPolicy Bypass -File .\admin\admin-report.ps1 `
    -ReportType Weekly `
    -Week "2026-W47" `
    -CentralStorePath "\\server\worktime" `
    -OutputDir ".\reports"
```

### 4. Interactive Workforce Web Dashboard
Open `admin/dashboard/index.html` in any modern web browser to view real-time productivity scorecards, shift ratios, application usage distributions, and export data.

---

## Running the Automated Test Suite

Run all 8 automated unit test suites with:
```powershell
powershell.exe -ExecutionPolicy Bypass -File .\tests\Run-Tests.ps1
```
