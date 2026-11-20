# Version History — Vserve-TimeChamp

## [v2.0.0] — 2026-11-20

### Type: Major Platform Evolution / Complete Workforce Management Platform
### Transformed:
- **VserveTimeChamp Enterprise Platform**:
  - Transformed application into an enterprise-grade workforce management, attendance tracking, and timesheet platform inspired by TimeChamp.
  - Deployed pure Node.js relational SQLite database layer (`admin/data/timechamp.db`, WAL mode enabled) with 11 relational entities, foreign keys, and indexes.
  - Implemented OWASP-recommended `scrypt` salted password hashing, `crypto.timingSafeEqual` constant-time verification, cryptographic token issuance, and strict 5-tier Role-Based Access Control (Super Admin, HR Admin, Manager, Team Leader, Employee).
  - Authored modular backend services:
    - `attendanceService.js`: Real-time clock-in/out, single active session concurrency locks, multi-type break tracking (Lunch, Tea, Meeting, Personal) with interval union deduplication, and timezone/overnight timesheet arithmetic (grace periods, late arrivals, overtime, shortfall).
    - `employeeService.js`: Scoped employee CRUD, duplicate ID/email guards, profile views, and bulk CSV import.
    - `shiftService.js`: Configurable shifts, grace periods, break allowances, overnight shifts spanning midnight, and department/team hierarchies.
    - `leaveService.js`: Leave balances (Annual, Sick, Casual, Unpaid), leave application workflows, and manager/HR review state machines.
    - `correctionService.js`: Attendance punch disputes, timesheet retroactive recalculations, and review workflows.
    - `auditService.js`: Tamper-evident, WORM-triggered audit logging across all organizational operations.
  - Integrated 1,360+ lines of REST routing logic into `admin/server.js` protected by authentication and RBAC middleware.
- **Modern SaaS Dashboard & UI/UX Redesign**:
  - Interactive **Clock-In / Break Management HUD** (`#clockHud`) with live session timer, status indicators, break buttons, and resume work actions.
  - Light and Dark theme engine (`data-theme="dark"` / `data-theme="light"`) with `#themeToggle`, local storage persistence, and `prefers-reduced-motion` compliance.
  - Added dedicated workforce portals:
    - **Shifts & Rostering** (`#tab-shifts`)
    - **Leave Management** (`#tab-leaves`)
    - **Attendance Corrections & Audit Trail** (`#tab-corrections`)
- **Automated Verification Matrix Certified**:
  - 169 / 169 automated API test suites passing across all 4 tiers (Features, Boundaries, Interactions, Workloads) with 0 failures.
  - 135 / 135 Playwright UI assertions certified across responsive desktop and mobile profiles.

---

## [v1.3.1] — 2026-11-20

### Type: Feature / Security / Auto-Update / Hardware Telemetry / UI-UX Modernization
### Added:
- **Zero-Touch Background Auto-Update Engine**:
  - The client tracking executable (`vserve-timechamp-setup.exe`) periodically checks the central cloud server (`/api/client/version`) on startup and every 5 minutes.
  - When changes or new builds are deployed to the server, the client quietly downloads `update_pending.exe`, launches an asynchronous replacement runner, seamlessly replaces itself, and restarts with `--autostart` without interrupting employee work.
- **Real-Time Device & Hardware Inventory System**:
  - Automatically queries machine motherboard/BIOS Serial Number via Win32 WMI and Registry fallback (`Win32_BIOS`).
  - Gathers dynamic CPU model, Logical Cores, and instant RAM memory usage (Total, Used, Free, Load %) via Win32 `GlobalMemoryStatusEx`.
  - Gathers local Fixed Disks storage capacities and utilization via `DriveInfo`.
  - Detects public working IP on the server via `x-forwarded-for` / socket address, alongside local LAN IPv4.
  - Dedicated **Device & Hardware Inventory** tab on Admin Dashboard with hardware KPI statistics and interactive modal breakdown.
- **Locked Tracking Server URL**:
  - Tracking server URL is permanently locked to `http://34.93.182.141:3000` inside the client executable. Employees cannot view or edit server endpoints.
- **Strict Password Authentication Enforcement**:
  - Passwords are strictly required for both Admin Portal sign-in and Employee Client tracking login.
  - Created initial credentials for `Samuel P` (Admin / Lead) with password `Samuel@2026`.
- **Term Standardization ("Team Name")**:
  - Renamed all UI references from "Workstation" / "Assigned Workstation Name" to "Team Name" across timesheets, employee directories, and registration modals.
- **Zero-Screenshot Architecture**:
  - Completely purged all screenshot viewer tabs, buttons, checkboxes, background capture routines, and storage endpoints across both server and client.

---

## [v1.3.0] — 2026-11-20

### Type: Feature / Security / Deployment
### Deployed:
- Deployed production backend and live dashboard server to GCP Compute Engine instance `samuel-automation-server` (Public IP: `34.93.182.141`, Port `3000`).
- Containerized tracking server via Docker with automatic restart (`unless-stopped`) and persistent volume mounts for activities, states, and user accounts.
- Integrated public 1-click download of the standalone tracking executable at `http://34.93.182.141:3000/download/vserve-timechamp-setup.exe`.

### Added:
- Multi-environment data directory resolution (`LOCAL_DATA_DIR`) supporting both local Windows workstations and containerized Linux servers.
- Automatic daily user state recording (`state_YYYY-MM-DD.json`) on remote heartbeats to support cross-network timesheets and analytics.
- Dockerfile and `docker-compose.yml` for zero-downtime deployment.
- Production pre-configured cloud tracking server URL (`http://34.93.182.141:3000`) in client tracking agent setup.

### Fixed:
- Clean platform check in `isAgentRunning()` to prevent executing `powershell.exe` on non-Windows server environments.
- Deprecated `url.parse()` replaced with WHATWG `new url.URL()` to avoid node security deprecation warnings.
- Windows batch file syntax loop parsing in `start-dashboard.bat`.

### Removed:
- Completely eliminated screenshot capture, screenshot saving, and screenshot storage per strict privacy policy ("No Need Screenshot Save").
- Removed Screenshots Viewer tab and screenshot viewer UI controls from the web dashboard.
- Disabled on-demand and periodic screenshot routines in tracking client and backend APIs.

---

## [v1.2.0] — 2026-11-19
- Modern TimeChamp-style Glassmorphism Admin Dashboard (Live Pulse, Analytics, Timesheets, Directory, Fleet Policies).
- Real installed system data only (zero mock/demo data).
- Strict RBAC: Tracked employees restricted from Admin Portal; only administrators can sign in.
- Standalone self-contained single `.exe` tracking installer (`vserve-timechamp-setup.exe`) with auto-start, system tray icon, and minimal HUD.
