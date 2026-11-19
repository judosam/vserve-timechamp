# Vserve-TimeChamp — Architecture Specification

**Project:** Vserve-TimeChamp (Windows Active-Time, Workforce & Productivity Tracker)  
**Stack:** Windows built-in PowerShell 5.1 (+ Win32 P/Invoke / .NET 4.5+ / UI Automation), no third-party applications, no administrative privileges required.  
**Scale:** Designed for 20 users initially, scaling seamlessly to hundreds across distributed fleets.  
**Version:** 1.2 (Production Architecture)  

---

## 1. Executive Summary & Design Principles

The **Vserve-TimeChamp** system is an enterprise workplace monitoring and productivity analytics utility replicating TimeChamp's core client capabilities natively for Windows. It measures active session time, application usage, website URLs, and productivity scores per employee workstation with minimal resource consumption, zero UI distraction, and zero third-party dependencies.

### Core Tenets
1. **Zero Distraction & Silent Mode:** Operates silently in the background without popups, tray icons, notifications, or window flashes.
2. **Reverse-Engineered Feature Parity:** Provides core capabilities matching TimeChamp v1.2:
   - Win32 `GetLastInputInfo` idle detection.
   - Active foreground application and window title tracking.
   - Browser URL tracking via Windows UI Automation (Chrome, Edge, Brave) without extensions.
   - Always-On Watchdog keeper (`vserve-watchdog.ps1`, replicating `Aos.TimeChamp.exe`).
   - Productivity scoring (Productive / Unproductive / Neutral).
   - Optional periodic multi-monitor screenshot auditing with privacy blur.
3. **No Administrative Rights:** Runs entirely within the standard user context (`HKCU`, `%LOCALAPPDATA%\VserveTimeChamp`).
4. **Resilient & Crash-Proof:** Monotonically accumulates active time across reboots, crashes, logoffs, and network disconnects.
5. **Decoupled Architecture:** Agent processes produce standard CSV, JSON, and state files. Admin reporting tools generate multi-sheet Excel workbooks (`.xlsx`) and host the visual workforce dashboard.

---

## 2. Component Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       EMPLOYEE WORKSTATION (Fleet x20-500)                  │
│                                                                             │
│  User Logon (HKCU Run Key / User Scheduled Task)                            │
│        │                                                                    │
│        ├─────────────────────────────────────────┐                          │
│        ▼                                         ▼                          │
│  launcher.vbs (Agent Launcher)             launcher-watchdog.vbs            │
│        │                                         │                          │
│        ▼                                         ▼                          │
│  ┌────────────────────────────────────────┐  ┌───────────────────────────┐  │
│  │ agent.ps1 (Vserve-TimeChamp Agent)     │  │ vserve-watchdog.ps1       │  │
│  │ - Polls GetLastInputInfo (Win32)       │  │ (Always-On Watchdog)      │  │
│  │ - Foreground App & Window Tracking     │  │ Monitors agent PID/mutex  │  │
│  │ - UI Automation Browser URL Extractor  │  │ Auto-kickstarts agent     │  │
│  │ - Productivity Classification Rules    │  └─────────────┬─────────────┘  │
│  │ - Monotonic active_seconds counter     │                │                │
│  │ - Optional Screenshots with Blur       │ ◄──────────────┘ Restarts       │
│  └───────────────────┬────────────────────┘                                 │
│                      │                                                      │
│                      │ Atomic Save (.tmp -> move)                           │
│                      ▼                                                      │
│     Local Data Store (%LOCALAPPDATA%\VserveTimeChamp\)                      │
│     - state_YYYY-MM-DD.json                                                 │
│     - activities_YYYY-MM-DD.json / .csv                                     │
│     - daily_YYYY-MM-DD.csv                                                  │
│     - agent.log / watchdog.log                                              │
│                      │                                                      │
│                      │ Periodic & on Logoff                                 │
│                      ▼                                                      │
│  ┌────────────────────────────────────────┐                                 │
│  │ sync/Sync-Transport.ps1                │ ──── HTTPS / SMB Copy ───────┐  │
│  │ - Option A: SMB / UNC Share (Default)  │                              │  │
│  │ - Option C: Microsoft Graph (M365)     │                              │  │
│  │ - Option B: Google Drive API           │                              │  │
│  └────────────────────────────────────────┘                              │  │
└──────────────────────────────────────────────────────────────────────────┼──┘
                                                                           │
                                                                           ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                             ADMIN CENTRAL STORE                             │
│  \\server\worktime\<user>\                                                  │
│    ├── daily_<user>_YYYY-MM-DD.csv                                          │
│    └── activities_<user>_YYYY-MM-DD.csv                                     │
│                                                                             │
│        │                                                                    │
│        ▼                                                                    │
│  ┌────────────────────────────────────────┐                                 │
│  │ admin/admin-report.ps1                 │                                 │
│  │ - Daily / Weekly / Monthly / Custom    │                                 │
│  │ - Native OpenXML Multi-Sheet Excel     │                                 │
│  │ - CSV Exports                          │                                 │
│  └────────────────────────────────────────┘                                 │
│        │                                                                    │
│        ▼                                                                    │
│  ┌────────────────────────────────────────┐                                 │
│  │ admin/dashboard/index.html             │                                 │
│  │ - Interactive workforce web dashboard  │                                 │
│  │ - Employee status, timeline & charts   │                                 │
│  └────────────────────────────────────────┘                                 │
└─────────────────────────────────────────────────────────────────────────────┘
```
