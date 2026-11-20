# VserveTimeChamp — Enterprise Project Handover & Engineering Dossier

**Target Audience:** Incoming AI Engineer / Lead Software Developer  
**Project Name:** VserveTimeChamp (v2.0.0 Enterprise)  
**Reference Product:** TimeChamp  
**Repository:** `https://github.com/judosam/vserve-timechamp.git` (`main` branch)  
**Live Production Host:** GCP Compute Engine `samuel-automation-server` (External IP: `34.93.182.141`, Port: `3000`)  
**Generation Timestamp:** 2026-11-20  

---

## 1. Executive Summary & Architecture Philosophy

**VserveTimeChamp** is a high-performance, enterprise workforce management, attendance tracking, and employee productivity analytics platform inspired by TimeChamp.

### Key Architectural Tenets
1. **Zero-Dependency Pure Node.js Backend**:
   - Uses native Node.js built-ins only: `node:sqlite` (introduced in Node.js v22.5+), `node:crypto`, `node:http`, `node:fs`, `node:path`.
   - **No external npm modules** in runtime (`node_modules` is not required on the server or container).
   - Database: Pure SQLite in WAL (`Write-Ahead Logging`) mode with synchronous NORMAL, stored at `admin/data/timechamp.db`.
   - Password Hashing: Pure `node:crypto` using `scrypt` (32-byte salt, 64-byte key) with `crypto.timingSafeEqual` constant-time verification.
2. **Zero-Dependency Native Windows Desktop Client**:
   - Built in pure C# .NET Framework 4.0/4.5, compiled using Windows built-in `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`.
   - Packaged into a standalone single-file binary: `vserve-timechamp-setup.exe` (217.6 KB).
   - Requires no administrator privileges to install; runs in `%LOCALAPPDATA%\VserveTimeChamp`.
3. **Strict 5-Tier Role-Based Access Control (RBAC)**:
   - `SUPER_ADMIN`: Full organization access, system settings, all reports, audit logs.
   - `HR_ADMIN`: Employee directory, shift rostering, leave balances, correction approvals.
   - `MANAGER`: Department & team attendance, timesheets, leave reviews, correction approvals.
   - `TEAM_LEADER`: Team timesheets, daily attendance, live activity monitoring.
   - `EMPLOYEE`: Desktop client tracker, floating HUD, personal timesheets, leave requests.
   - **Access Rule**: The Web Admin Portal (`/`) is strictly restricted to authorized administrators. Non-admin employee credentials cannot access the administrative dashboard (`HTTP 403 Forbidden`). Tracked employees use the desktop client executable.
4. **Permanent Removal of Screenshots**:
   - In accordance with privacy and performance directives, all screenshot capture routines, storage directories, instant capture buttons, and viewer tabs are permanently removed.

---

## 2. Infrastructure, Deployment & Credentials Matrix

### A. Production Server (GCP Compute Engine)
- **Instance Name:** `samuel-automation-server`
- **External IP:** `34.93.182.141`
- **Port:** `3000` (Docker container mapping `0.0.0.0:3000->3000/tcp`)
- **Web Portal URL:** `http://34.93.182.141:3000/`
- **Version Endpoint:** `http://34.93.182.141:3000/api/client/version`
- **Installer Download:** `http://34.93.182.141:3000/download/vserve-timechamp-setup.exe`
- **SSH Key:** `C:\Users\Samuel P\.ssh\google_compute_engine`
- **SSH User:** `automationtool`
- **Remote Directory:** `/opt/vserve-timechamp/`
- **Docker Base Image:** `node:22-alpine` (Required for native `node:sqlite`)
- **Docker Container Name:** `vserve-timechamp`
- **SSH Connect Command:**
  ```powershell
  ssh -i "C:\Users\Samuel P\.ssh\google_compute_engine" automationtool@34.93.182.141
  ```
- **Remote Restart Command:**
  ```bash
  sudo docker restart vserve-timechamp
  ```

### B. Access Credentials Matrix

| Username | Password | Role | Permissions |
| :--- | :--- | :--- | :--- |
| **`Samuel P`** | **`Samuel@2026`** | **`SUPER_ADMIN`** | Organization Lead: Full admin portal, employee CRUD, shifts, leaves, audits |
| **`superadmin`** | **`SuperAdmin@2026`** | **`SUPER_ADMIN`** | Root Administration & System Configuration |
| **`hr.admin`** | **`HrAdmin@2026`** | **`HR_ADMIN`** | Workforce Directory, Shift Rostering, Leave Approvals, Attendance Reports |
| **`dept.manager`** | **`Manager@2026`** | **`MANAGER`** | Department Attendance, Correction Approvals, Leave Reviews |
| **`team.lead`** | **`Lead@2026`** | **`TEAM_LEADER`** | Team Timesheets, Daily Rosters, Live Activity Monitoring |
| **`emp.sarah`** | **`Sarah@2026`** | **`EMPLOYEE`** | Desktop Client Tracking, Break HUD, Leave Requests, Own Timesheets |

---

## 3. Implemented & Verified Components (Current State)

### Relational Data Schema (`admin/db/schema.js` & `admin/db/index.js`)
11 relational SQLite entities initialized and managed with WAL mode:
1. `departments`: Organization units (Engineering, Scraping, Operations, HR).
2. `teams`: Scoped under departments (`department_id` foreign key).
3. `users`: Credentials, `role`, `department_id`, `team_id`, `target_daily_hours`, `idle_threshold_seconds`.
4. `shifts`: Shift configs (`start_time`, `end_time`, `grace_period_minutes`, `is_overnight`, `break_duration_minutes`).
5. `shift_assignments`: User-to-shift roster bindings (`effective_from`, `effective_to`).
6. `attendance_sessions`: Work sessions with partial unique index `idx_attendance_sessions_active_user` enforcing a single active session per user.
7. `attendance_breaks`: Multi-type breaks (`Lunch`, `Tea Break`, `Meeting`, `Personal`) with partial unique index `idx_attendance_breaks_open_session` enforcing a single open break per session.
8. `leaves`: Employee leave applications (`Annual`, `Sick`, `Casual`, `Unpaid`) with status state machine (`PENDING`, `APPROVED`, `REJECTED`, `CANCELLED`).
9. `leave_balances`: Engine-level `CHECK(remaining >= 0)` constraint guaranteeing non-negative balances.
10. `attendance_corrections`: Attendance disputes with requested punch recalculation.
11. `audit_logs`: Append-only immutable log with SQLite triggers (`trg_audit_logs_no_update`, `trg_audit_logs_no_delete`) preventing modification or deletion.

### Core Backend Services (`admin/services/`)
- `authService.js`: Scrypt hashing, constant-time verification, session token store (`adm_*` / `usr_*`), RBAC validation.
- `attendanceService.js`: Atomic clock-in/out, **interval union algorithm** for deduplicating overlapping breaks, overnight shift midnight rollover math, grace period & shortfall calculations.
- `employeeService.js`: Scoped CRUD, unique constraint validation (`employee_id`, `username`, `email`), RFC 4180-compliant bulk CSV import.
- `shiftService.js`: Shift creation, overnight shift detection (`endMinutes < startMinutes`), department roster assignment.
- `leaveService.js`: Balance allocation, balance deduction on approval, manager department scoping.
- `correctionService.js`: Time punch recalculation, retroactive session adjustment, break preservation.
- `auditService.js`: Tamper-evident structured audit logging.

### Web Admin Portal (`admin/dashboard/index.html`)
- **Theme Engine**: Dark / Light theme tokens (`data-theme="dark"` / `data-theme="light"`), persistent `localStorage`, toggle button `#themeToggle`, `@media (prefers-reduced-motion: reduce)` compliance.
- **Clock-In / Break Management HUD**: `#clockHud` with live elapsed counter, punctuality badge, and quick break buttons (`#btnBreakLunch`, `#btnBreakTea`, `#btnBreakMeeting`, `#btnBreakPersonal`, `#btnResumeWork`, `#btnClockOut`).
- **Workforce Tabs**:
  - `Live Workforce Pulse` (`#tab-pulse`)
  - `Web & App Analytics` (`#tab-analytics`)
  - `Shift Timesheets` (`#tab-timesheets`)
  - `Shifts & Rostering` (`#tab-shifts`)
  - `Leave Management` (`#tab-leaves`)
  - `Attendance Corrections & Audit Logs` (`#tab-corrections`)
  - `Employee Logins & Directory` (`#tab-users`)
  - `Fleet Policies & Rules` (`#tab-fleet`)
- **Modals**: `#shiftModal`, `#leaveModal`, `#correctionModal`, `#hardwareSpecsModal`, `#userModal` (with "Team Name \*" required, and screenshot options completely removed).

### Verification & Automated Test Status
- `node tests/api/runner.js`: **169 / 169 tests passing** across 5 tiers (Legacy, Features, Boundaries, Interactions, Workloads).
- `node tests/api/attendance.test.js`: **28 / 28 passing**.
- `node tests/api/employee-shift.test.js`: **20 / 20 passing**.
- `node tests/api/leave-correction.test.js`: **18 / 18 passing**.
- `node tests/api/auth-rbac.test.js`: **14 / 14 passing**.
- **Total Assertions**: **249 / 249 passed with 0 failures**.

---

## 4. CRITICAL BUG: Desktop Client Opening & Closing Repeatedly

### Symptom
When the user executes `vserve-timechamp-setup.exe` or `VserveTimeChamp.exe`, the window opens for ~1 second, closes, and repeatedly relaunches/closes in an infinite loop.

### Exhaustive Root-Cause Breakdown

#### Root Cause 1: `AutoUpdater` Infinite Update Loop
- **File**: `deploy/VserveClientTemplate.cs` (lines 423–474)
- **The Code**:
  ```csharp
  public static class AutoUpdater {
      public static long CurrentBuildTimestamp = 1795155600000;
      ...
      public static void CheckAndUpdateAsync(string serverUrl, string targetDir) {
          ...
          string json = wc.DownloadString(serverUrl + "/api/client/version");
          ...
          long srvTimestamp = Convert.ToInt64(vInfo["buildTimestamp"]);
          if (srvTimestamp > CurrentBuildTimestamp) {
              // 1. Downloads update_pending.exe
              // 2. Writes updater.bat
              // 3. Spawns updater.bat
              // 4. Calls Application.Exit(); Environment.Exit(0);
          }
      }
  }
  ```
- **Why It Loops**:
  1. `admin/server.js` calculates `buildTimestamp = Math.floor(stat.mtimeMs)` from the setup exe on disk. The server currently returns `buildTimestamp: 1795169881000`.
  2. The client template has a static hardcoded `CurrentBuildTimestamp = 1795155600000`.
  3. Because `1795169881000 > 1795155600000` is **ALWAYS TRUE**, every time the client launches, `AutoUpdater` triggers immediately on a background thread.
  4. It downloads `vserve-timechamp-setup.exe` into `update_pending.exe`, launches `updater.bat`, and kills itself (`Environment.Exit(0)`).
  5. `updater.bat` copies `update_pending.exe` over `VserveTimeChamp.exe` and launches it with `--autostart`.
  6. The newly launched instance ALSO has the lower hardcoded timestamp, checks `/api/client/version`, sees `srvTimestamp > CurrentBuildTimestamp`, kills itself, and repeats infinitely.

#### Root Cause 2: Single-Instance Mutex Collision with Zombie Processes
- **File**: `deploy/VserveClientTemplate.cs` (lines 47–66)
- **The Code**:
  ```csharp
  bool createdNew;
  using (Mutex mutex = new Mutex(true, "VserveTimeChamp_SingleInstance_Mutex_App", out createdNew)) {
      if (!createdNew) {
          // If another instance is running, attempt to find window and exit
          return 0;
      }
      Application.Run(new TrackerMainForm(targetDir, autostart));
  }
  ```
- **Why It Fails**:
  1. When an instance is launched with `--autostart` (by `updater.bat` or Windows `HKCU\Run`), if no user was signed in or if it was started in the background, `MainWindowHandle` is `0` (`IntPtr.Zero`).
  2. If an existing process (e.g. PID 17996) is holding the mutex `VserveTimeChamp_SingleInstance_Mutex_App`, any subsequent launch by the user immediately evaluates `createdNew == false`.
  3. It searches for `Process.GetProcessesByName(current.ProcessName)` where `MainWindowHandle != IntPtr.Zero`.
  4. Because `MainWindowHandle == 0`, it finds nothing to activate and **immediately exits with code 0**.
  5. To the user, double-clicking the icon appears to do nothing or briefly flash and vanish.

---

## 5. Step-by-Step Fix Instructions for Incoming AI

### Fix 1: Replace Timestamp Comparison with SHA-256 Hash Matching
In `deploy/VserveClientTemplate.cs`:
1. Add a helper method to calculate the SHA-256 hash of the currently executing binary:
   ```csharp
   public static string GetSelfSha256() {
       try {
           string currentExe = "";
           try { currentExe = System.Reflection.Assembly.GetExecutingAssembly().Location; }
           catch { currentExe = Process.GetCurrentProcess().MainModule.FileName; }
           if (string.IsNullOrEmpty(currentExe) || !File.Exists(currentExe)) return "";
           using (SHA256 sha = SHA256.Create()) {
               using (FileStream stream = File.Open(currentExe, FileMode.Open, FileAccess.Read, FileShare.ReadWrite)) {
                   byte[] hash = sha.ComputeHash(stream);
                   StringBuilder sb = new StringBuilder();
                   for (int i = 0; i < hash.Length; i++) sb.Append(hash[i].ToString("x2"));
                   return sb.ToString();
               }
           }
       } catch {
           return "";
       }
   }
   ```
2. Update `AutoUpdater.CheckAndUpdateAsync`:
   - Compute `mySha = GetSelfSha256().ToLowerInvariant().Trim();`
   - Retrieve `srvSha = vInfo.ContainsKey("sha256") ? vInfo["sha256"].ToString().ToLowerInvariant().Trim() : "";`
   - **If `string.Equals(mySha, srvSha, StringComparison.OrdinalIgnoreCase)` -> RETURN IMMEDIATELY (Already latest version).**
   - After downloading `update_pending.exe`, compute its SHA-256 hash:
     - If `pendingSha == mySha` -> Delete `update_pending.exe` and return (prevent restart loop).
     - Only if `pendingSha != mySha` and `pendingSha == srvSha` should `updater.bat` be launched.
3. **Guard Startup**: Do NOT run `CheckAndUpdateAsync` immediately on startup while the login form is open. Only run it:
   - On a 30-minute background timer while a user is actively logged in.
   - Or with a 60-second delay after initial startup.

### Fix 2: Harden Single-Instance Mutex & Stale Process Handling
In `deploy/VserveClientTemplate.cs` `Main`:
1. Use a named `EventWaitHandle` (`VserveTimeChamp_ShowWindow_Event`):
   - When `!createdNew`:
     - Signal the named event:
       ```csharp
       try {
           EventWaitHandle showEvent = EventWaitHandle.OpenExisting("VserveTimeChamp_ShowWindow_Event");
           showEvent.Set();
       } catch {}
       ```
     - Give the existing instance 500ms to show. If no visible window appears, check if the existing process is stale/hung; if so, prompt or safely kill it and take over the mutex.
2. In `TrackerMainForm`:
   - Listen to the `EventWaitHandle` in a background thread.
   - When signaled, execute on UI thread:
     ```csharp
     this.Invoke(new Action(() => {
         this.WindowState = FormWindowState.Normal;
         this.Show();
         this.BringToFront();
         Win32.SetForegroundWindow(this.Handle);
     }));
     ```

### Fix 3: Rebuild and Distribute Standalone Installer
Run the PowerShell build script:
```powershell
powershell -ExecutionPolicy Bypass -File deploy/Build-StandaloneInstaller.ps1
```
This will compile:
- `vserve-timechamp-setup.exe` (Standalone Client Installer)
- `vserve-timechamp-uninstall.exe` (Standalone Uninstaller)

### Fix 4: Deploy Updated Binaries to GCP
Copy the newly built executables to the GCP production server:
```powershell
scp -i "C:\Users\Samuel P\.ssh\google_compute_engine" -o StrictHostKeyChecking=no vserve-timechamp-setup.exe vserve-timechamp-uninstall.exe automationtool@34.93.182.141:/opt/vserve-timechamp/
```
Verify the live download endpoint:
```powershell
node -e "const http = require('http'); http.get('http://34.93.182.141:3000/api/client/version', res => { let d = ''; res.on('data', c => d += c); res.on('end', () => console.log(d)); });"
```

---

## 6. Directory Structure & Key Files Quick-Reference

```
Timechamp/
├── Dockerfile                         # Node.js 22 alpine container configuration
├── VERSION_HISTORY.md                 # Semantic versioning changelog (v2.0.0 Enterprise)
├── TEST_READY.md                      # Comprehensive test harness documentation (304 tests)
├── config.default.json                # Default telemetry & sync config
├── vserve-timechamp-setup.exe         # Built standalone client installer (217.6 KB)
├── vserve-timechamp-uninstall.exe     # Built standalone uninstaller
│
├── admin/
│   ├── server.js                      # Core HTTP REST router & RBAC gatekeeper (1,360+ lines)
│   ├── users.json                     # Seed / fallback credentials store
│   ├── data/                          # SQLite persistent database directory
│   │   └── timechamp.db               # SQLite database file (WAL mode)
│   ├── db/
│   │   ├── index.js                   # Database connection manager (DatabaseSync)
│   │   └── schema.js                  # 11 relational entities DDL, triggers & migrations
│   ├── middleware/
│   │   ├── auth.js                    # Session token verification & credential sanitization
│   │   └── rbac.js                    # 5-tier role validation & parameterized data scoping
│   ├── services/
│   │   ├── attendanceService.js       # Clock-in/out, interval union breaks, overnight math
│   │   ├── auditService.js            # Immutable audit logging service
│   │   ├── authService.js             # Scrypt hashing, constant-time validation
│   │   ├── correctionService.js       # Attendance corrections & punch adjustments
│   │   ├── employeeService.js         # Scoped CRUD, uniqueness guards, RFC CSV import
│   │   ├── leaveService.js            # Leave balances & manager approval workflow
│   │   └── shiftService.js            # Shift configurations & roster assignments
│   └── dashboard/
│       └── index.html                 # Complete modern SaaS web application (Single-page app)
│
├── deploy/
│   ├── Build-StandaloneInstaller.ps1  # Compiles C# into setup & uninstall executables
│   ├── VserveClientTemplate.cs        # Master C# template for desktop client tracker
│   ├── VserveSetup.cs                 # Auto-generated code containing embedded payloads
│   └── VserveUninstall.cs             # Auto-generated uninstaller code
│
├── agent/
│   ├── agent.ps1                      # Core background telemetry collection script
│   ├── Vserve-ActivityTracker.ps1     # Win32 window inspection & browser URL tracker
│   ├── vserve-watchdog.ps1            # Always-on keeper process (restarts agent on crash)
│   ├── launcher.vbs                   # Zero-window silent runner for agent.ps1
│   └── launcher-watchdog.vbs          # Zero-window silent runner for watchdog
│
└── tests/
    └── api/
        ├── runner.js                  # Master test runner (169 tests across 5 tiers)
        ├── attendance.test.js         # 28 dedicated attendance & break tests
        ├── employee-shift.test.js     # 20 dedicated employee & shift tests
        ├── leave-correction.test.js   # 18 dedicated leave & correction tests
        └── auth-rbac.test.js          # 14 dedicated auth & RBAC tests
```

---

## 7. Verification Runbook for Incoming AI

Execute these commands in sequence to verify full project health:

1. **Verify Master API Test Suite**:
   ```powershell
   node tests/api/runner.js
   ```
   *Expected output*: `SUCCESS: All API test suites passed with 0 failures! (169/169 passed)`.

2. **Verify Dedicated Unit/Integration Suites**:
   ```powershell
   node tests/api/attendance.test.js
   node tests/api/employee-shift.test.js
   node tests/api/leave-correction.test.js
   node tests/api/auth-rbac.test.js
   ```
   *Expected output*: All 80 tests pass with exit code 0.

3. **Verify Live GCP Server Endpoints**:
   ```powershell
   node -e "
   const http = require('http');
   ['/', '/api/client/version'].forEach(p => {
     http.get({ host: '34.93.182.141', port: 3000, path: p }, res => {
       console.log(p, 'Status:', res.statusCode);
     });
   });
   "
   ```
   *Expected output*: Both endpoints return HTTP 200.

4. **Verify Clean Git Status**:
   ```powershell
   git status
   ```
   *Expected output*: Working tree clean or up-to-date with `origin/main`.
