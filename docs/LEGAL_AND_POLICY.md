# Workplace Active-Time Tracking: Legal Basis, Compliance & Policy Template

**Scope:** Workplace deployment of the Lightweight Windows Active-Time Tracker  
**Applicability:** India (DPDP Act 2023), European Union (GDPR), United States (Federal & State workplace privacy laws).  

---

## 1. Compliance & Legal Framework

### 1.1 The Principle of Data Minimization
Under modern privacy statutes (including India's Digital Personal Data Protection Act 2023 and the EU General Data Protection Regulation / GDPR Art. 5(1)(c)), monitoring must adhere strictly to **data minimization**:
- **What Work Timer Collects:**
  - Aggregated seconds of keyboard/mouse input activity per day.
  - Duration of inactive intervals (pauses exceeding 10 minutes).
  - High-level timestamps of first and last input of the day.
  - Workstation hostname and local username.
- **What Work Timer Explicitly DOES NOT Collect:**
  - Keylogging (no key contents or character sequences are inspected or stored).
  - Screen recording, screenshots, or webcam capture.
  - Window titles, application names, or visited URLs.
  - File access, network traffic content, or password entry.

This focused design ensures compliance with privacy mandates while delivering accurate shift active-time metrics.

### 1.2 "Silent" vs "Covert" Tracking
There is a critical legal distinction between **silent** operation and **covert/surreptitious** monitoring:
- **Silent Operation (Permissible):** The agent runs with no distracting pop-ups, tray animations, or sound alerts to preserve employee productivity and focus.
- **Covert Monitoring (Legally Risky):** Attempting to actively conceal monitoring from employees without legal notice exposes organizations to statutory penalties, labour disputes, and regulatory liability.

**Recommendation:** Maintain an open, documented monitoring policy with signed employee acknowledgements.

---

## 2. Workplace Time-Tracking Policy Template

*(Organizations should adapt the following template with their internal legal and HR counsel)*

### Policy: Automated Active-Time Recording for Workplace Operations

**Effective Date:** `[DD Month YYYY]`  
**Target Group:** All employees and contractors utilizing company-issued computer equipment.

#### 1. Purpose
The Company utilizes an automated Work Timer utility on company-managed devices to record active working hours, assist with payroll computation, and ensure balanced workload distribution across teams.

#### 2. Scope of Measurement
The utility automatically aggregates the amount of time during the work shift when keyboard or mouse input is detected:
1. **Active Time:** Time intervals during which keyboard or mouse activity is present.
2. **Idle Pauses:** Intervals of 10 or more consecutive minutes with no keyboard or mouse activity are treated as break time.
3. **No Content Surveillance:** The system does not record keystroke details, screen captures, audio, video, web browsing history, or private messages.

#### 3. Data Storage & Retention
- Daily activity logs are stored on secure internal servers.
- Logs are retained for a rolling period of 90 days, after which detailed records are purged and archived into monthly statistical summaries.

---

## 3. Employee Acknowledgement Form

```
I, __________________________________ [Employee Name], acknowledge that I have 
received, read, and understood the Company's Workplace Time-Tracking Policy.

I understand that an automated background utility is active on my company-provided 
workstation to measure aggregate active and idle work hours during my scheduled shift. 
I understand that no personal messages, screen captures, or keystroke contents 
are recorded by this software.

Employee Signature: ____________________________________

Employee ID:        ____________________________________

Date:               ____________________________________
```
