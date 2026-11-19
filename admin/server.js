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

const PORT = process.env.PORT || 3000;
const ROOT_DIR = path.resolve(__dirname, '..');
const DASHBOARD_DIR = path.join(__dirname, 'dashboard');
const CONFIG_FILE = path.join(ROOT_DIR, 'config.default.json');
const LOCAL_DATA_DIR = path.join(process.env.LOCALAPPDATA || '', 'VserveTimeChamp');

const USERS_FILE = path.join(__dirname, 'users.json');

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
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
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

  // Live telemetry endpoint (ONLY real system data)
  if (pathname === '/api/live' && req.method === 'GET') {
    const now = Date.now();
    const result = [];
    const seenUsers = new Set();

    // 1. Live heartbeats
    for (const [username, data] of liveUsers.entries()) {
      seenUsers.add(username);
      const lastSeenMs = new Date(data.lastSeen || 0).getTime();
      const diffSec = (now - lastSeenMs) / 1000;
      let effectiveStatus = data.status || 'Active';
      if (diffSec > 90) {
        effectiveStatus = 'Offline';
      } else if (data.status === 'idle') {
        effectiveStatus = 'Idle';
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
      if (!seenUsers.has(rec.user)) {
        result.push(rec);
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // Aggregated analytics endpoint (Tracked apps and websites)
  if (pathname === '/api/analytics' && req.method === 'GET') {
    const analytics = getAggregatedAnalytics();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(analytics));
    return;
  }

  // User Management endpoints (Creation and administration from Admin Portal)
  if (pathname === '/api/users' && req.method === 'GET') {
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

        // Verify password / PIN if set
        if (found.password && payload.password && found.password !== payload.password) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Incorrect password or PIN' }));
          return;
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
    const records = getRealReportRecords();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(records));
    return;
  }

  // Configuration endpoint
  if (pathname === '/api/config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getConfig()));
    return;
  }

  if (pathname === '/api/config' && req.method === 'POST') {
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

server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`  Vserve-TimeChamp Live Tracking Server Running`);
  console.log(`  Access Dashboard: http://localhost:${PORT}`);
  console.log(`  (Displaying real installed system data only)`);
  console.log(`=======================================================`);
});
