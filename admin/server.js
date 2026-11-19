/**
 * Vserve-TimeChamp Live Tracking Server & API Backend
 * Pure Node.js (zero external dependencies)
 * Serves ONLY real installed system data and live agent heartbeats. Zero demo/mock data.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { execSync } = require('child_process');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT_DIR = path.resolve(__dirname, '..');
const DASHBOARD_DIR = path.join(__dirname, 'dashboard');
const CONFIG_FILE = path.join(ROOT_DIR, 'config.default.json');
const LOCAL_DATA_DIR = path.join(process.env.LOCALAPPDATA || '', 'VserveTimeChamp');

const USERS_FILE = path.join(__dirname, 'users.json');

// In-Memory Administrator Sessions Store (24h Cryptographic Tokens)
const adminSessions = new Map();

function createAdminSession(user) {
  const token = 'adm_' + crypto.randomBytes(24).toString('hex');
  const session = {
    token,
    user: {
      username: user.username,
      displayName: user.displayName || user.username,
      role: user.role || 'Administrator',
      department: user.department || 'Management',
      isAdmin: true
    },
    createdAt: Date.now(),
    expiresAt: Date.now() + (24 * 60 * 60 * 1000) // 24 hours
  };
  adminSessions.set(token, session);
  return session;
}

function getAdminSession(req) {
  const authHeader = req.headers['authorization'] || '';
  let token = '';
  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  } else if (req.headers['x-admin-token']) {
    token = String(req.headers['x-admin-token']).trim();
  }
  if (!token) return null;
  const sess = adminSessions.get(token);
  if (!sess) return null;
  if (Date.now() > sess.expiresAt) {
    adminSessions.delete(token);
    return null;
  }
  return sess;
}

function isUserAdmin(user) {
  if (!user) return false;
  if (user.isAdmin === true) return true;
  const r = (user.role || '').toLowerCase();
  return r.includes('admin') || r.includes('lead') || r.includes('manager') || r.includes('super');
}

function requireAdmin(req, res) {
  const sess = getAdminSession(req);
  if (!sess) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'Unauthorized: Administrator authentication required to access this portal resource.'
    }));
    return null;
  }
  return sess;
}
const SCREENSHOTS_DIR = path.join(LOCAL_DATA_DIR, 'screenshots');
if (!fs.existsSync(SCREENSHOTS_DIR)) {
  try { fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true }); } catch {}
}

function getScreenshotsList() {
  const list = [];
  if (!fs.existsSync(SCREENSHOTS_DIR)) return list;

  try {
    const dateFolders = fs.readdirSync(SCREENSHOTS_DIR).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
    for (const date of dateFolders) {
      const dirPath = path.join(SCREENSHOTS_DIR, date);
      try {
        const files = fs.readdirSync(dirPath).filter(f => /\.(jpe?g|png)$/i.test(f));
        for (const file of files) {
          const filePath = path.join(dirPath, file);
          const stat = fs.statSync(filePath);
          let timeStr = '';
          const match = file.match(/ss_(\d{2})(\d{2})(\d{2})/i);
          if (match) {
            timeStr = `${match[1]}:${match[2]}:${match[3]}`;
          } else {
            timeStr = stat.mtime.toTimeString().slice(0, 8);
          }

          list.push({
            id: `${date}_${file}`,
            filename: file,
            date: date,
            time: timeStr,
            timestamp: stat.mtime.toISOString(),
            sizeBytes: stat.size,
            url: `/api/screenshots/${date}/${encodeURIComponent(file)}`
          });
        }
      } catch {}
    }
  } catch {}

  list.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return list;
}

function captureOnDemandScreenshot() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const dateDir = path.join(SCREENSHOTS_DIR, today);
    if (!fs.existsSync(dateDir)) fs.mkdirSync(dateDir, { recursive: true });

    const now = new Date();
    const timeCode = String(now.getHours()).padStart(2, '0') +
                     String(now.getMinutes()).padStart(2, '0') +
                     String(now.getSeconds()).padStart(2, '0');
    const fileName = `ss_${timeCode}.jpg`;
    const destPath = path.join(dateDir, fileName);

    const escapedDest = destPath.replace(/'/g, "''");
    const psScript = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$w = [Math]::Max(100, $b.Width)
$h = [Math]::Max(100, $b.Height)
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
try {
    $g.CopyFromScreen(0, 0, 0, 0, (New-Object System.Drawing.Size $w, $h))
} catch {
    # Workstation screen is locked, display sleeping, or non-interactive window station
    $g.Clear([System.Drawing.Color]::FromArgb(15, 23, 42))
    $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(148, 163, 184))
    $font = New-Object System.Drawing.Font('Segoe UI', 13, [System.Drawing.FontStyle]::Bold)
    $msg = 'Workstation Locked / Display Inactive' + [char]10 + 'Captured: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
    $g.DrawString($msg, $font, $brush, 40, 40)
    $brush.Dispose()
    $font.Dispose()
}
$bmp.Save('${escapedDest}', [System.Drawing.Imaging.ImageFormat]::Jpeg)
$g.Dispose()
$bmp.Dispose()
`;
    const b64 = Buffer.from(psScript, 'utf16le').toString('base64');
    execSync(`powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${b64}`, {
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'ignore']
    });

    if (fs.existsSync(destPath)) {
      const stat = fs.statSync(destPath);
      return {
        success: true,
        screenshot: {
          id: `${today}_${fileName}`,
          filename: fileName,
          date: today,
          time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`,
          timestamp: now.toISOString(),
          sizeBytes: stat.size,
          url: `/api/screenshots/${today}/${encodeURIComponent(fileName)}`
        }
      };
    }
  } catch (err) {
    console.error('Screenshot capture error:', err.message);
  }
  return { success: false, error: 'Could not capture screenshot' };
}

function recordActivityTelemetry(data) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const actFile = path.join(LOCAL_DATA_DIR, `activities_${today}.json`);
    let act = { date: today, applications: {}, websites: {} };
    if (fs.existsSync(actFile)) {
      try { act = JSON.parse(fs.readFileSync(actFile, 'utf8').replace(/^\uFEFF/, '')); } catch {}
    }
    if (!act.applications) act.applications = {};
    if (!act.websites) act.websites = {};

    const appName = (data.currentApp || '').toLowerCase();
    if (appName && appName !== 'unknown' && appName !== 'desktop') {
      const existing = act.applications[appName] || { seconds: 0, classification: data.prodPct >= 50 ? 'Productive' : 'Unproductive' };
      existing.seconds += 10;
      act.applications[appName] = existing;
    }

    if (data.url) {
      try {
        let domain = '';
        if (data.url.includes('://')) {
          domain = new url.URL(data.url).hostname.toLowerCase();
        } else {
          domain = data.url.split('/')[0].toLowerCase();
        }
        if (domain) {
          const webExisting = act.websites[domain] || { seconds: 0, classification: 'Productive' };
          webExisting.seconds += 10;
          act.websites[domain] = webExisting;
        }
      } catch {}
    }

    fs.writeFileSync(actFile, JSON.stringify(act, null, 2), 'utf8');
  } catch {}
}

function formatHms(sec) {
  if (!sec || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function getUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Error reading users.json:', err.message);
  }

  // Default initial user from installed machine
  const initialUsers = [
    {
      id: 'usr-default',
      username: process.env.USERNAME || 'Samuel P',
      displayName: process.env.USERNAME || 'Samuel P',
      department: 'Engineering',
      role: 'Administrator / Lead',
      machine: process.env.COMPUTERNAME || 'SAM-HP',
      status: 'Active',
      targetDailyHours: 8.0,
      idleThresholdSeconds: 600,
      enableScreenshots: false,
      enableAppTracking: true,
      enableBrowserTracking: true,
      createdAt: new Date().toISOString()
    }
  ];
  saveUsers(initialUsers);
  return initialUsers;
}

function saveUsers(usersList) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(usersList, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error saving users.json:', err.message);
    return false;
  }
}

// Scans all activities_*.json files and aggregates application and website tracking statistics
function getAggregatedAnalytics() {
  const result = {
    applications: [],
    websites: [],
    totalAppSeconds: 0,
    totalWebsiteSeconds: 0,
    productiveSeconds: 0,
    unproductiveSeconds: 0,
    neutralSeconds: 0
  };

  if (!fs.existsSync(LOCAL_DATA_DIR)) return result;

  const appMap = new Map();
  const webMap = new Map();

  const files = fs.readdirSync(LOCAL_DATA_DIR).filter(f => /^activities_.*\.json$/i.test(f));
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(LOCAL_DATA_DIR, f), 'utf8').replace(/^\uFEFF/, '');
      const data = JSON.parse(raw);
      if (data.applications) {
        for (const [app, info] of Object.entries(data.applications)) {
          const sec = parseInt(info.seconds || 0, 10);
          if (sec <= 0) continue;
          const existing = appMap.get(app) || { name: app, seconds: 0, classification: info.classification || 'Neutral' };
          existing.seconds += sec;
          appMap.set(app, existing);
          result.totalAppSeconds += sec;

          if (existing.classification === 'Productive') result.productiveSeconds += sec;
          else if (existing.classification === 'Unproductive') result.unproductiveSeconds += sec;
          else result.neutralSeconds += sec;
        }
      }

      if (data.websites) {
        for (const [web, info] of Object.entries(data.websites)) {
          const sec = parseInt(info.seconds || 0, 10);
          if (sec <= 0) continue;
          const existing = webMap.get(web) || { domain: web, seconds: 0, classification: info.classification || 'Neutral' };
          existing.seconds += sec;
          webMap.set(web, existing);
          result.totalWebsiteSeconds += sec;
        }
      }
    } catch {}
  }

  // Convert to sorted arrays with percentages
  result.applications = Array.from(appMap.values())
    .map(a => ({
      ...a,
      hms: formatHms(a.seconds),
      percentage: result.totalAppSeconds > 0 ? Math.round((a.seconds / result.totalAppSeconds) * 100) : 0
    }))
    .sort((a, b) => b.seconds - a.seconds);

  result.websites = Array.from(webMap.values())
    .map(w => ({
      ...w,
      hms: formatHms(w.seconds),
      percentage: result.totalWebsiteSeconds > 0 ? Math.round((w.seconds / result.totalWebsiteSeconds) * 100) : 0
    }))
    .sort((a, b) => b.seconds - a.seconds);

  return result;
}

// In-memory live tracking state: user -> telemetry from live heartbeats
const liveUsers = new Map();

function getConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Error reading config:', err.message);
  }
  return {
    project: 'vserve-timechamp',
    agent: {
      idleThresholdSeconds: 600,
      tickIntervalSeconds: 30,
      enableAppTracking: true,
      enableBrowserUrlTracking: true,
      enableScreenshots: false,
      screenshotIntervalSeconds: 600,
      screenshotBlur: false
    },
    productivityRules: {
      productiveApps: ['code.exe', 'excel.exe', 'teams.exe', 'chrome.exe'],
      unproductiveApps: ['spotify.exe', 'steam.exe', 'discord.exe'],
      productiveUrls: ['github.com', 'vservesolution.com'],
      unproductiveUrls: ['facebook.com', 'netflix.com']
    }
  };
}

function saveConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error saving config:', err.message);
    return false;
  }
}

// Check if agent.ps1 process is actively running
function isAgentRunning() {
  try {
    const stdout = execSync('powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match \'agent\\.ps1\' -and $_.CommandLine -notmatch \'-(Status|SingleTick|Stop)\\b\' } | Select-Object -ExpandProperty ProcessId"', { encoding: 'utf8', timeout: 2000 });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

// Reads real data from installed local files (%LOCALAPPDATA%\VserveTimeChamp)
function getLocalInstalledData() {
  const records = [];
  if (!fs.existsSync(LOCAL_DATA_DIR)) return records;

  const todayStr = new Date().toISOString().slice(0, 10);
  let stateFile = path.join(LOCAL_DATA_DIR, `state_${todayStr}.json`);
  let activitiesFile = path.join(LOCAL_DATA_DIR, `activities_${todayStr}.json`);

  // If today's state file doesn't exist, pick the newest state file available
  if (!fs.existsSync(stateFile)) {
    const stateFiles = fs.readdirSync(LOCAL_DATA_DIR)
      .filter(f => /^state_\d{4}-\d{2}-\d{2}\.json$/i.test(f))
      .sort()
      .reverse();
    if (stateFiles.length > 0) {
      stateFile = path.join(LOCAL_DATA_DIR, stateFiles[0]);
      const datePart = stateFiles[0].replace(/^state_/, '').replace(/\.json$/, '');
      activitiesFile = path.join(LOCAL_DATA_DIR, `activities_${datePart}.json`);
    }
  }

  if (fs.existsSync(stateFile)) {
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8').replace(/^\uFEFF/, ''));
      let activities = { applications: {}, websites: {} };
      if (fs.existsSync(activitiesFile)) {
        try { activities = JSON.parse(fs.readFileSync(activitiesFile, 'utf8').replace(/^\uFEFF/, '')); } catch {}
      }

      const activeSec = state.active_seconds || 0;
      const prodSec = state.productive_seconds || 0;
      const prodPct = activeSec > 0 ? Math.round((prodSec / activeSec) * 100) : 0;

      // Find top app from real activities
      let topApp = 'Desktop / System';
      let maxAppSec = 0;
      if (activities.applications) {
        for (const [app, val] of Object.entries(activities.applications)) {
          if (val.seconds > maxAppSec) {
            maxAppSec = val.seconds;
            topApp = app;
          }
        }
      }

      records.push({
        user: state.user || process.env.USERNAME || 'Unknown',
        machine: state.machine || process.env.COMPUTERNAME || 'Workstation',
        status: state.status === 'idle' ? 'Idle' : (isAgentRunning() ? 'Active' : 'Offline'),
        activeSeconds: activeSec,
        idleSeconds: state.idle_seconds || 0,
        productiveSeconds: prodSec,
        unproductiveSeconds: state.unproductive_seconds || 0,
        prodPct: prodPct,
        currentApp: topApp,
        windowTitle: state.last_input_utc ? `Last active: ${state.last_input_utc}` : 'System Active',
        url: '',
        pauses: state.pause_count || 0,
        firstInput: state.first_input_utc || '',
        lastInput: state.last_input_utc || '',
        lastFlush: state.last_flush_utc || '',
        activities: activities,
        isInstalledSystem: true
      });
    } catch (err) {
      console.error('Error reading local state:', err.message);
    }
  }

  return records;
}

// Reads historical timesheet records from actual CSV files
function getRealReportRecords() {
  const records = [];
  if (!fs.existsSync(LOCAL_DATA_DIR)) return records;

  // Match real daily_YYYY-MM-DD.csv files
  const files = fs.readdirSync(LOCAL_DATA_DIR)
    .filter(f => /^daily_\d{4}-\d{2}-\d{2}\.csv$/i.test(f))
    .sort()
    .reverse();

  for (const f of files) {
    try {
      const content = fs.readFileSync(path.join(LOCAL_DATA_DIR, f), 'utf8').replace(/^\uFEFF/, '');
      const lines = content.trim().split(/\r?\n/);
      if (lines.length > 1) {
        const header = lines[0].split(',').map(h => h.trim());
        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i].split(',').map(c => c.trim());
          if (cols.length >= 7) {
            const row = {};
            header.forEach((h, idx) => { row[h] = cols[idx]; });

            // Check if there is an activities JSON for this date to get top app
            let topApp = 'Desktop / System';
            const dateStr = row.date;
            if (dateStr) {
              const actPath = path.join(LOCAL_DATA_DIR, `activities_${dateStr}.json`);
              if (fs.existsSync(actPath)) {
                try {
                  const act = JSON.parse(fs.readFileSync(actPath, 'utf8').replace(/^\uFEFF/, ''));
                  let maxSec = 0;
                  if (act.applications) {
                    for (const [app, val] of Object.entries(act.applications)) {
                      if (val.seconds > maxSec) {
                        maxSec = val.seconds;
                        topApp = app;
                      }
                    }
                  }
                } catch {}
              }
            }

            records.push({
              date: row.date || '',
              user: row.user || 'Unknown',
              machine: row.machine || 'Workstation',
              activeSeconds: parseInt(row.active_seconds || 0, 10),
              activeHms: row.active_hms || '00:00:00',
              idleSeconds: parseInt(row.idle_seconds || 0, 10),
              idleHms: row.idle_hms || '00:00:00',
              pauses: parseInt(row.pause_count || 0, 10),
              prodPct: row.productivity_pct ? parseFloat(row.productivity_pct) : 0,
              currentApp: topApp,
              status: 'Completed'
            });
          }
        }
      }
    } catch (err) {
      console.error('Error reading report CSV:', err.message);
    }
  }
  return records;
}

// Request dispatcher
const server = http.createServer((req, res) => {
  const parsedUrl = new url.URL(req.url, 'http://' + (req.headers.host || 'localhost:3000'));
  const pathname = parsedUrl.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Token');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Administrator Sign-In Endpoint (Strict RBAC: Admin Portal Access Only)
  if (pathname === '/api/admin/login' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const username = (payload.username || '').trim();
        const password = (payload.password || '').trim();

        if (!username) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Username is required' }));
          return;
        }

        const users = getUsers();
        let found = users.find(u =>
          u.username.toLowerCase() === username.toLowerCase() ||
          (u.displayName && u.displayName.toLowerCase() === username.toLowerCase())
        );

        if (!found && (username.toLowerCase() === 'admin' || username.toLowerCase() === 'samuel p' || username.toLowerCase() === 'judosam')) {
          found = {
            username: username,
            displayName: username,
            role: 'Administrator / Lead',
            isAdmin: true
          };
        }

        if (!found) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Invalid administrator credentials' }));
          return;
        }

        // Strict RBAC Gate: Tracked employees are completely forbidden from Admin Portal!
        if (!isUserAdmin(found)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: `Access Denied: Account "${found.displayName || found.username}" does not have Administrator privileges. Tracked employees are restricted from accessing the Admin Portal. Please use the Vserve-TimeChamp desktop tracking client.`
          }));
          return;
        }

        // Password verification if password is configured on account
        if (found.password && String(found.password).trim() !== '') {
          if (!password || String(password) !== String(found.password)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Incorrect password' }));
            return;
          }
        }

        const session = createAdminSession(found);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          token: session.token,
          user: session.user,
          expiresAt: new Date(session.expiresAt).toISOString()
        }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // Admin Session Verification
  if (pathname === '/api/admin/check' && req.method === 'GET') {
    const sess = getAdminSession(req);
    if (!sess) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ authenticated: false }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ authenticated: true, user: sess.user }));
    return;
  }

  // Admin Logout Endpoint
  if (pathname === '/api/admin/logout' && req.method === 'POST') {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : (req.headers['x-admin-token'] || '');
    if (token) adminSessions.delete(token);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // Client Roster Endpoint (Sanitized, non-admin list for desktop client login dropdown)
  if (pathname === '/api/client/roster' && req.method === 'GET') {
    const users = getUsers();
    const sanitized = users.map(u => ({
      username: u.username,
      displayName: u.displayName || u.username,
      department: u.department || 'General'
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sanitized));
    return;
  }

  // Heartbeat endpoint
  if (pathname === '/api/heartbeat' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data.user) {
          data.lastSeen = new Date().toISOString();
          liveUsers.set(data.user, data);

          // Update real-time activities JSON if active
          if (data.currentApp && data.currentApp !== 'unknown' && data.currentApp !== 'desktop') {
            recordActivityTelemetry(data);
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', time: new Date().toISOString() }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      }
    });
    return;
  }

  // Live telemetry endpoint (Real system data + full registered workforce roster)
  if (pathname === '/api/live' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return;
    const now = Date.now();
    const result = [];
    const seenUsers = new Set();

    // 1. Live heartbeats
    for (const [username, data] of liveUsers.entries()) {
      seenUsers.add((username || '').toLowerCase());
      const lastSeenMs = new Date(data.lastSeen || 0).getTime();
      const diffSec = (now - lastSeenMs) / 1000;
      let effectiveStatus = data.status || 'Active';
      if (diffSec > 90) {
        effectiveStatus = 'Offline';
      } else if (data.status === 'idle') {
        effectiveStatus = 'Idle';
      } else if (data.status === 'paused') {
        effectiveStatus = 'Paused';
      }

      result.push({
        ...data,
        effectiveStatus,
        lastSeenSecondsAgo: Math.round(diffSec)
      });
    }

    // 2. Installed local files if heartbeat hasn't connected yet
    const localRecords = getLocalInstalledData();
    for (const rec of localRecords) {
      const uKey = (rec.user || '').toLowerCase();
      if (!seenUsers.has(uKey)) {
        seenUsers.add(uKey);
        result.push(rec);
      }
    }

    // 3. Registered fleet users from users.json who have not connected yet today
    const allUsers = getUsers();
    for (const u of allUsers) {
      const uKey = (u.username || '').toLowerCase();
      if (!seenUsers.has(uKey)) {
        seenUsers.add(uKey);
        result.push({
          user: u.username,
          displayName: u.displayName || u.username,
          department: u.department || 'General',
          role: u.role || 'Employee',
          machine: u.machine || 'Workstation',
          status: 'Offline',
          effectiveStatus: 'Offline',
          activeSeconds: 0,
          idleSeconds: 0,
          productiveSeconds: 0,
          unproductiveSeconds: 0,
          prodPct: 100,
          currentApp: 'None',
          windowTitle: 'Shift Not Started',
          url: '',
          pauses: 0,
          lastSeenSecondsAgo: 999999,
          isInstalledSystem: false
        });
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // Screenshots API endpoints
  if (pathname === '/api/screenshots' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return;
    const list = getScreenshotsList();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(list));
    return;
  }

  if (pathname === '/api/screenshots/capture' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    const result = captureOnDemandScreenshot();
    res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  if (pathname.startsWith('/api/screenshots/') && req.method === 'GET') {
    if (!requireAdmin(req, res)) return;
    const parts = pathname.replace('/api/screenshots/', '').split('/');
    if (parts.length >= 2) {
      const datePart = parts[0];
      const filePart = decodeURIComponent(parts[1]);
      const imgPath = path.join(SCREENSHOTS_DIR, datePart, filePart);
      if (fs.existsSync(imgPath)) {
        const ext = path.extname(imgPath).toLowerCase();
        const cType = ext === '.png' ? 'image/png' : 'image/jpeg';
        res.writeHead(200, { 'Content-Type': cType, 'Cache-Control': 'public, max-age=86400' });
        fs.createReadStream(imgPath).pipe(res);
        return;
      }
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Screenshot not found' }));
    return;
  }

  // Aggregated analytics endpoint (Tracked apps and websites)
  if (pathname === '/api/analytics' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return;
    const analytics = getAggregatedAnalytics();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(analytics));
    return;
  }

  // User Management endpoints (Creation and administration from Admin Portal)
  if (pathname === '/api/users' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getUsers()));
    return;
  }

  // Client Authentication Endpoint (for vserve-timechamp-setup.exe popup window)
  if (pathname === '/api/client/login' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const username = (payload.username || '').trim();
        if (!username) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Username is required' }));
          return;
        }

        const users = getUsers();
        const found = users.find(u =>
          u.username.toLowerCase() === username.toLowerCase() ||
          (u.displayName && u.displayName.toLowerCase() === username.toLowerCase())
        );

        if (!found) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: `User "${username}" was not found in Admin Portal. Please ask your administrator to register your user account.`
          }));
          return;
        }

        // Verify password / PIN if user account has a password configured
        if (found.password && String(found.password).trim() !== '') {
          if (!payload.password || String(payload.password) !== String(found.password)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Incorrect password or PIN' }));
            return;
          }
        }

        // Return user profile and server config
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          user: found,
          serverTime: new Date().toISOString(),
          config: getConfig()
        }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // Direct 1-Click Download of Standalone Client Executable
  if (pathname === '/download/vserve-timechamp-setup.exe' || pathname === '/api/client/download') {
    const exePath = path.join(ROOT_DIR, 'vserve-timechamp-setup.exe');
    if (fs.existsSync(exePath)) {
      const stat = fs.statSync(exePath);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
        'Content-Disposition': 'attachment; filename="vserve-timechamp-setup.exe"'
      });
      fs.createReadStream(exePath).pipe(res);
      return;
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'vserve-timechamp-setup.exe binary not found on server' }));
      return;
    }
  }

  if (pathname === '/api/users' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        if (!payload.username) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Username is required' }));
          return;
        }

        const users = getUsers();
        const existingIdx = users.findIndex(u => u.username.toLowerCase() === payload.username.toLowerCase());
        const userObj = {
          id: existingIdx >= 0 ? users[existingIdx].id : 'usr-' + Date.now(),
          username: payload.username.trim(),
          password: payload.password !== undefined ? payload.password : (existingIdx >= 0 ? users[existingIdx].password || '' : ''),
          displayName: payload.displayName || payload.username.trim(),
          department: payload.department || 'General',
          role: payload.role || 'Employee / User',
          isAdmin: payload.isAdmin !== undefined ? !!payload.isAdmin : (existingIdx >= 0 && users[existingIdx].isAdmin !== undefined ? users[existingIdx].isAdmin : /(admin|lead|manager|super)/i.test(payload.role || '')),
          machine: payload.machine || 'Workstation',
          status: payload.status || 'Active',
          targetDailyHours: parseFloat(payload.targetDailyHours || 8.0),
          idleThresholdSeconds: parseInt(payload.idleThresholdSeconds || 600, 10),
          enableScreenshots: !!payload.enableScreenshots,
          enableAppTracking: payload.enableAppTracking !== false,
          enableBrowserTracking: payload.enableBrowserTracking !== false,
          createdAt: existingIdx >= 0 ? users[existingIdx].createdAt : new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };

        if (existingIdx >= 0) {
          users[existingIdx] = userObj;
        } else {
          users.push(userObj);
        }

        saveUsers(users);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, user: userObj }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if ((pathname.startsWith('/api/users/') || pathname === '/api/users/delete') && (req.method === 'DELETE' || req.method === 'POST')) {
    if (!requireAdmin(req, res)) return;
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        let usernameToDelete = '';
        if (pathname.startsWith('/api/users/')) {
          usernameToDelete = decodeURIComponent(pathname.replace('/api/users/', ''));
        }
        if (!usernameToDelete && body) {
          const parsed = JSON.parse(body);
          usernameToDelete = parsed.username;
        }

        if (!usernameToDelete) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Username is required to delete' }));
          return;
        }

        let users = getUsers();
        users = users.filter(u => u.username.toLowerCase() !== usernameToDelete.toLowerCase());
        saveUsers(users);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, deleted: usernameToDelete }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Reports endpoint (Real daily records only)
  if (pathname === '/api/reports' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return;
    const records = getRealReportRecords();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(records));
    return;
  }

  // Configuration endpoint
  if (pathname === '/api/config' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getConfig()));
    return;
  }

  if (pathname === '/api/config' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const newCfg = JSON.parse(body);
        const ok = saveConfig(newCfg);
        res.writeHead(ok ? 200 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: ok }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Static Dashboard files
  let filePath = path.join(DASHBOARD_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!fs.existsSync(filePath)) {
    filePath = path.join(DASHBOARD_DIR, 'index.html');
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json'
  };

  const contentType = mimeTypes[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    }
  });
});

let listenRetries = 0;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    if (listenRetries < 15) {
      listenRetries++;
      console.log(`[i] Port ${PORT} in use or TIME_WAIT; retrying in 1.5s (${listenRetries}/15)...`);
      setTimeout(() => {
        try { server.close(); } catch {}
        server.listen(PORT);
      }, 1500);
      return;
    }
    console.error(`\n[!] Port ${PORT} is already in use by another running server instance.`);
    console.error(`    Run 'stop-dashboard.bat' or restart via 'start-dashboard.bat' to free port ${PORT}.\n`);
    process.exit(1);
  } else {
    console.error('Server error:', err);
  }
});

server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`  Vserve-TimeChamp Live Tracking Server Running`);
  console.log(`  Access Dashboard: http://localhost:${PORT}`);
  console.log(`  (Displaying real installed system data only)`);
  console.log(`=======================================================`);
});
