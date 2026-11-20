# Version History — Vserve-TimeChamp

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
