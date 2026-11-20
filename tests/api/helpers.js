/**
 * VserveTimeChamp API Test Helpers & Utilities
 * Pure Node.js (node:test, node:assert, native fetch)
 * Target: process.env.SERVER_URL || 'http://localhost:3000'
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DEFAULT_SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';

const ROLES = Object.freeze({
  SUPER_ADMIN: 'SUPER_ADMIN',
  HR_ADMIN: 'HR_ADMIN',
  MANAGER: 'MANAGER',
  TEAM_LEADER: 'TEAM_LEADER',
  EMPLOYEE: 'EMPLOYEE'
});

const PREDEFINED_USERS = Object.freeze({
  SUPER_ADMIN: {
    username: 'superadmin',
    password: 'SuperAdmin@2026',
    role: 'SUPER_ADMIN',
    displayName: 'Super Admin User',
    department: 'Executive',
    team: 'Management'
  },
  HR_ADMIN: {
    username: 'hr.admin',
    password: 'HrAdmin@2026',
    role: 'HR_ADMIN',
    displayName: 'HR Admin User',
    department: 'Human Resources',
    team: 'HR Operations'
  },
  MANAGER: {
    username: 'dept.manager',
    password: 'Manager@2026',
    role: 'MANAGER',
    displayName: 'Engineering Manager',
    department: 'Engineering',
    team: 'Engineering Leads'
  },
  TEAM_LEADER: {
    username: 'team.lead',
    password: 'Lead@2026',
    role: 'TEAM_LEADER',
    displayName: 'Core Team Leader',
    department: 'Engineering',
    team: 'Core Engineering Team'
  },
  EMPLOYEE: {
    username: 'emp.sarah',
    password: 'Sarah@2026',
    role: 'EMPLOYEE',
    displayName: 'Sarah Miller',
    department: 'Productivity & QA',
    team: 'Productivity & QA Team'
  },
  LEGACY_ADMIN: {
    username: 'Samuel P',
    password: 'Samuel@2026',
    role: 'Administrator / Lead',
    displayName: 'Samuel P',
    department: 'Engineering',
    team: 'Core Engineering Team',
    isAdmin: true
  }
});

/**
 * Low-level HTTP request helper using native fetch
 */
async function request(endpoint, options = {}) {
  const baseUrl = options.baseUrl || DEFAULT_SERVER_URL;
  const url = endpoint.startsWith('http://') || endpoint.startsWith('https://')
    ? endpoint
    : `${baseUrl.replace(/\/+$/, '')}/${endpoint.replace(/^\/+/, '')}`;

  const method = (options.method || 'GET').toUpperCase();
  const headers = { ...options.headers };

  if (options.token) {
    headers['Authorization'] = `Bearer ${options.token}`;
  } else if (options.adminToken) {
    headers['X-Admin-Token'] = options.adminToken;
  }

  let body = options.body;
  if (body && typeof body === 'object' && !(body instanceof FormData) && !(body instanceof URLSearchParams)) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    body = JSON.stringify(body);
  }

  const fetchOpts = {
    method,
    headers,
    signal: options.signal || (options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : AbortSignal.timeout(15000))
  };

  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && body !== undefined) {
    fetchOpts.body = body;
  }

  try {
    const res = await fetch(url, fetchOpts);
    const contentType = res.headers.get('content-type') || '';
    let data = null;
    let rawText = '';

    try {
      rawText = await res.text();
      if (contentType.includes('application/json') || rawText.trim().startsWith('{') || rawText.trim().startsWith('[')) {
        data = JSON.parse(rawText);
      }
    } catch {
      data = null;
    }

    const isSpaFallback = endpoint.includes('/api/') && (contentType.includes('text/html') || data === null);

    return {
      status: res.status,
      ok: res.ok,
      headers: Object.fromEntries(res.headers.entries()),
      data,
      rawText,
      isSpaFallback
    };
  } catch (err) {
    return {
      status: 0,
      ok: false,
      headers: {},
      data: null,
      rawText: '',
      error: err.message
    };
  }
}

/**
 * Dynamic API Client instance with stateful Bearer auth
 */
class ApiClient {
  constructor(baseUrl = DEFAULT_SERVER_URL) {
    this.baseUrl = baseUrl;
    this.token = null;
    this.adminToken = null;
  }

  setToken(token) {
    this.token = token;
    return this;
  }

  setAdminToken(token) {
    this.adminToken = token;
    return this;
  }

  clearAuth() {
    this.token = null;
    this.adminToken = null;
    return this;
  }

  async request(endpoint, options = {}) {
    return request(endpoint, {
      baseUrl: this.baseUrl,
      token: options.token !== undefined ? options.token : this.token,
      adminToken: options.adminToken !== undefined ? options.adminToken : this.adminToken,
      ...options
    });
  }

  async get(endpoint, options = {}) {
    return this.request(endpoint, { ...options, method: 'GET' });
  }

  async post(endpoint, body, options = {}) {
    return this.request(endpoint, { ...options, method: 'POST', body });
  }

  async put(endpoint, body, options = {}) {
    return this.request(endpoint, { ...options, method: 'PUT', body });
  }

  async delete(endpoint, options = {}) {
    return this.request(endpoint, { ...options, method: 'DELETE' });
  }

  /**
   * Primary authentication helper: tries /api/auth/login first, then /api/admin/login
   */
  async login(username, password) {
    const authRes = await this.post('/api/auth/login', { username, password });
    if (authRes.status === 200 && authRes.data && authRes.data.token) {
      this.setToken(authRes.data.token);
      return {
        token: authRes.data.token,
        user: authRes.data.user,
        response: authRes
      };
    }

    // Fallback to legacy admin login
    const adminRes = await this.post('/api/admin/login', { username, password });
    if (adminRes.status === 200 && adminRes.data && adminRes.data.token) {
      this.setToken(adminRes.data.token);
      this.setAdminToken(adminRes.data.token);
      return {
        token: adminRes.data.token,
        user: adminRes.data.user || { username, role: 'ADMIN' },
        response: adminRes
      };
    }

    return {
      token: null,
      user: null,
      response: authRes.status !== 0 ? authRes : adminRes
    };
  }

  /**
   * Role-based login helper using predefined test credentials
   */
  async loginAs(roleKey) {
    const creds = PREDEFINED_USERS[roleKey];
    if (!creds) {
      throw new Error(`Unknown role key: ${roleKey}. Allowed: ${Object.keys(PREDEFINED_USERS).join(', ')}`);
    }
    return this.login(creds.username, creds.password);
  }
}

/**
 * Unique generators for isolated and self-contained test execution
 */
let counter = 0;
function uniqueSuffix() {
  counter++;
  return `${Date.now()}_${counter}_${Math.random().toString(36).substring(2, 7)}`;
}

function generateEmployeeId(prefix = 'EMP') {
  return `${prefix}${Math.floor(100000 + Math.random() * 900000)}`;
}

function generateEmail(prefix = 'user') {
  return `${prefix}.${uniqueSuffix()}@vservetimechamp.internal`;
}

function generateUsername(prefix = 'usr') {
  return `${prefix}_${uniqueSuffix()}`;
}

function generateShiftData(overrides = {}) {
  const suffix = uniqueSuffix();
  return {
    name: `Shift_${suffix}`,
    code: `SH_${suffix.slice(-4).toUpperCase()}`,
    startTime: '09:00',
    endTime: '18:00',
    targetHours: 8.0,
    graceMinutes: 15,
    isOvernight: false,
    breakAllowanceMinutes: 60,
    ...overrides
  };
}

function generateDepartmentData(overrides = {}) {
  const suffix = uniqueSuffix();
  return {
    name: `Dept_${suffix}`,
    code: `D${suffix.slice(-3).toUpperCase()}`,
    description: `Test Department ${suffix}`,
    ...overrides
  };
}

function generateTeamData(departmentId, overrides = {}) {
  const suffix = uniqueSuffix();
  return {
    name: `Team_${suffix}`,
    code: `T${suffix.slice(-3).toUpperCase()}`,
    departmentId,
    description: `Test Team ${suffix}`,
    ...overrides
  };
}

function generateEmployeeData(overrides = {}) {
  const suffix = uniqueSuffix();
  return {
    employeeId: generateEmployeeId(),
    username: generateUsername('emp'),
    email: generateEmail('emp'),
    password: 'Password@2026!',
    displayName: `Test Employee ${suffix}`,
    role: ROLES.EMPLOYEE,
    status: 'ACTIVE',
    targetDailyHours: 8.0,
    ...overrides
  };
}

/**
 * Assertion helpers
 */
function assertStatus(res, expectedStatus, message) {
  assert.equal(
    res.status,
    expectedStatus,
    message || `Expected HTTP ${expectedStatus}, received HTTP ${res.status}. Body: ${res.rawText}`
  );
}

function assertSuccess(res, expectedStatus = 200, message) {
  assertStatus(res, expectedStatus, message);
  assert.ok(!res.isSpaFallback, message || `Expected API JSON response, but received SPA HTML fallback.`);
  assert.ok(
    res.data && (res.data.success === true || res.data.status === 'ok' || Array.isArray(res.data) || res.ok),
    message || `Expected success flag in response data, got: ${JSON.stringify(res.data)}`
  );
}

function assertError(res, expectedStatus, expectedError) {
  assertStatus(res, expectedStatus);
  assert.ok(res.data !== null, `Expected JSON response body, got: ${res.rawText}`);
  if (typeof res.data.success !== 'undefined') {
    assert.equal(res.data.success, false, 'Expected success: false in error response');
  }
  if (expectedError) {
    const errorStr = (res.data.error || res.data.message || res.rawText || '').toLowerCase();
    if (expectedError instanceof RegExp) {
      assert.match(errorStr, expectedError);
    } else {
      assert.ok(
        errorStr.includes(String(expectedError).toLowerCase()),
        `Expected error to contain '${expectedError}', received '${errorStr}'`
      );
    }
  }
}

function assertSchema(obj, requiredFields, label = 'Object') {
  assert.ok(obj && typeof obj === 'object', `${label} must be a valid object`);
  for (const field of requiredFields) {
    assert.ok(
      field in obj && obj[field] !== undefined && obj[field] !== null,
      `${label} is missing required field '${field}'. Keys present: ${Object.keys(obj).join(', ')}`
    );
  }
}

/**
 * Server Lifecycle Management for standalone test execution
 */
let managedServerProcess = null;

async function isServerAlive(url = DEFAULT_SERVER_URL) {
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/api/client/version`, {
      signal: AbortSignal.timeout(1500)
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function ensureServerRunning(url = DEFAULT_SERVER_URL, port = 3000) {
  if (await isServerAlive(url)) {
    return null;
  }

  const serverJs = path.resolve(__dirname, '..', '..', 'admin', 'server.js');
  const env = { ...process.env, PORT: String(port) };

  managedServerProcess = spawn(process.execPath, [serverJs], {
    env,
    stdio: 'ignore',
    detached: false
  });

  // Poll until ready or timeout 10 seconds
  const start = Date.now();
  while (Date.now() - start < 10000) {
    await new Promise(r => setTimeout(r, 400));
    if (await isServerAlive(url)) {
      return managedServerProcess;
    }
  }

  throw new Error(`Managed server failed to start within 10 seconds at ${url}`);
}

function stopManagedServer() {
  if (managedServerProcess && !managedServerProcess.killed) {
    try {
      managedServerProcess.kill();
    } catch {}
    managedServerProcess = null;
  }
}

module.exports = {
  DEFAULT_SERVER_URL,
  ROLES,
  PREDEFINED_USERS,
  ApiClient,
  request,
  uniqueSuffix,
  generateEmployeeId,
  generateEmail,
  generateUsername,
  generateShiftData,
  generateDepartmentData,
  generateTeamData,
  generateEmployeeData,
  assertStatus,
  assertSuccess,
  assertError,
  assertSchema,
  isServerAlive,
  ensureServerRunning,
  stopManagedServer
};
