# Vserve-TimeChamp — Lightweight Windows Workforce & Active-Time Tracker

A production-grade, zero-dependency, silent background active-time tracker and productivity analytics solution replicating TimeChamp's core client capabilities natively for Windows using C#, .NET 4.0+, Win32 P/Invoke, and UI Automation.

Designed for fleets of 20 to 500+ employees. Requires **no administrative privileges**, **no third-party runtime installs**, and produces **zero UI distractions**.

---

## 1-Click Quick Deployment (Single Machine or Fleet)

### Standalone Single Executable with Popup Widget (`vserve-timechamp-setup.exe`)
Simply double-click **`vserve-timechamp-setup.exe`** on any employee machine:
- **No external runtimes needed** (zero Node.js, zero Python, zero third-party dependencies required on client).
- **Self-Installs & Auto-Starts:** Drops payload to `%LOCALAPPDATA%\VserveTimeChamp\` and registers auto-start in `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`.
- **Interactive Popup Experience:**
  1. **Login Menu:** Employee selects or enters their username created by the admin in the Admin Portal.
  2. **Minimal Tracking Widget:** Once authenticated, switches to a sleek desktop floating card showing:
     - Real-time digital stopwatch timer (`HH:MM:SS`) ticking live every second.
     - Live Tracking Status badge (`● ACTIVE` in emerald green, `⏸ PAUSED` in amber, `💤 IDLE` in orange).
     - Focused application and website domain (`code.exe — server.js`, `chrome.exe (github.com)`) with productivity classification tag.
     - Today's shift summary (Active work time, away/idle time, productivity %).
     - Controls: Pause / Resume tracking, Open Admin Portal in browser, Hide to System Tray, Switch User.
  3. **System Tray Integration:** Minimizing or closing the window parks it in the Windows notification tray with hover tooltips and right-click menu (`Show Tracker`, `Pause/Resume`, `Open Portal`, `Sign Out`, `Exit`).
- To run silently in automated fleet deployments without UI: run with `--silent` or `/silent`.
- To cleanly uninstall: double-click **`vserve-timechamp-uninstall.exe`**.

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
1. **🟢 Live Workforce Pulse:** Real-time pulse cards showing all employees (Active, Idle, Paused, and Offline), currently focused application, active browser URL, live ticking timer, and productivity meters.
2. **📊 Web & App Analytics:** Complete breakdown of all desktop applications and browser websites visited with duration, percentage bars, and classification.
3. **📸 Screenshots Viewer:** Full interactive gallery of desktop screenshots with employee filter, date picker, on-demand capture trigger, and high-resolution lightbox modal.
4. **⏱️ Shift Timesheets:** Consolidated daily work logs with one-click CSV and Excel export.
5. **👤 Employee Directory & User Management:** Create new employee login accounts, assign workstations, configure custom idle thresholds, toggle screenshot auditing, and dispatch global fleet policies. Newly created users can immediately log into the single executable.
6. **⚙️ Fleet Policies & Rules:** Configure productive/unproductive applications and domains, idle thresholds, and sync intervals.
7. **⬇️ 1-Click Download:** Download `vserve-timechamp-setup.exe` directly from the dashboard header (`/download/vserve-timechamp-setup.exe`).

---

## Key Features & Reverse-Engineered Capabilities

- **Accurate Active-Time Primitive:** Uses the Win32 `GetLastInputInfo` API with unsigned 32-bit tick arithmetic to measure active time without invasive keylogging.
- **Application & Active Window Tracking:** Replicates TimeChamp's `WindowsProcessUsageTracker` via Win32 `GetForegroundWindow` and `QueryFullProcessImageName` to track active process names (`code.exe`, `excel.exe`, `chrome.exe`) and window titles.
- **Extension-Less Browser URL Tracking:** Replicates TimeChamp's `UiAutomationElementPathFinder` using Windows UI Automation (`UIAutomationClient`) to read the address bar of Google Chrome, Microsoft Edge, and Brave without browser extensions.
- **Productivity Classification:** Automatically classifies activities into **Productive**, **Unproductive**, and **Neutral** based on configurable regex rules.
- **Always-On Watchdog Service:** Replicates TimeChamp's `Aos.TimeChamp.exe` watchdog (`vserve-watchdog.ps1` + `launcher-watchdog.vbs`) to automatically kick-start the agent if terminated or closed unexpectedly.
- **Monotonic & Crash-Proof Persistence:** Records running state every 30 seconds atomically (`.tmp` -> rename) to `%LOCALAPPDATA%\VserveTimeChamp\`. Resumes uninterrupted across machine crashes, logoffs, and reboots.
- **Zero-Window Silent Execution:** Launched via WScript shims (`SW_HIDE = 0`) to guarantee zero console window flash on logon.
- **Desktop Screenshot Auditing:** Multi-monitor GDI+ screen capture (`System.Drawing.Graphics.CopyFromScreen`) with date-organized storage and on-demand capture trigger via Admin Portal.
- **Multi-Transport Central Sync:**
  - **Option A (Default):** Automated push to central SMB/UNC network share (`\\server\worktime\<user>\daily_<user>_<date>.csv`) with offline tolerance and backlog catchup.
  - **Option C:** Direct upload to Microsoft 365 SharePoint / OneDrive via Microsoft Graph API.
  - **Option B:** Google Drive API upload support.
- **Zero-Dependency Admin Reporting & OpenXML Engine:** Generates Daily, Weekly (ISO Wxx), Monthly, and Custom Range consolidated reports with multi-sheet styled Excel workbooks (`.xlsx`) using native .NET `ZipArchive`.
- **Interactive Workforce Web Dashboard:** Modern visual dashboard (`admin/dashboard/index.html`) displaying employee shift ratios, productivity scores, app/web usage charts, screenshots gallery, and export tools.
- **Automated Test Suite:** 10 complete automated test suites covering idle detection, state persistence, accumulation logic, sync transport, reporting, installer, activity tracking, watchdog service, live server telemetry, client popup authentication, and screenshot streaming.

---

## Testing & Quality Assurance

Run the complete test suite:
```powershell
powershell -ExecutionPolicy Bypass -File tests\Run-Tests.ps1
```
All 10 test suites validate functionality without modifying production data:
1. `Test-IdleDetector.ps1`
2. `Test-StatePersistence.ps1`
3. `Test-AccumulationLogic.ps1`
4. `Test-SyncTransport.ps1`
5. `Test-AdminReport.ps1`
6. `Test-Installer.ps1`
7. `Test-VserveActivityTracker.ps1`
8. `Test-VserveWatchdog.ps1`
9. `Test-LiveServer.ps1`
10. `Test-ClientPopupAndAuth.ps1`
