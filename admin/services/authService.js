/**
 * VserveTimeChamp Cryptographic Authentication & Session Service
 * Pure Node.js crypto module (Zero external dependencies)
 * 
 * Capabilities:
 * - Scrypt salted password hashing (N=16384, r=8, p=1, keylen=64)
 * - Constant-time password verification via crypto.timingSafeEqual
 * - On-the-fly migration of unhashed legacy credentials
 * - Cryptographic session token issuance (vt_ modern, adm_ legacy)
 * - Session store with in-memory caching
 * - Multi-source token extraction (Bearer, headers, query, cookies)
 * - 5-tier RBAC role normalization (SUPER_ADMIN, HR_ADMIN, MANAGER, TEAM_LEADER, EMPLOYEE)
 * - Sensitive credential redacting (safe user serialization)
 */

const crypto = require('crypto');

// Cryptographic Parameters (OWASP recommended scrypt parameters)
const HASH_CONFIG = {
  keylen: 64,             // 512-bit derived key
  cost: 16384,            // N = 2^14
  blockSize: 8,           // r = 8
  parallelization: 1,     // p = 1
  saltBytes: 16,          // 128-bit random salt
  maxmem: 32 * 1024 * 1024
};

// 5-Tier Canonical Roles
const ROLES = Object.freeze({
  SUPER_ADMIN: 'SUPER_ADMIN',
  HR_ADMIN: 'HR_ADMIN',
  MANAGER: 'MANAGER',
  TEAM_LEADER: 'TEAM_LEADER',
  EMPLOYEE: 'EMPLOYEE'
});

// Role Hierarchy for comparison
const ROLE_HIERARCHY = Object.freeze({
  SUPER_ADMIN: 5,
  HR_ADMIN: 4,
  MANAGER: 3,
  TEAM_LEADER: 2,
  EMPLOYEE: 1
});

// In-Memory Session Cache (Token -> Session Object)
const sessionCache = new Map();

/**
 * Derives a cryptographically secure salted hash using scrypt.
 * @param {string} password - Raw password
 * @param {string} [existingSalt] - Optional salt (for re-hashing)
 * @returns {{ salt: string, hash: string, formatted: string }}
 */
function hashPassword(password, existingSalt = null) {
  if (!password || typeof password !== 'string') {
    throw new Error('Password must be a non-empty string');
  }
  const salt = existingSalt || crypto.randomBytes(HASH_CONFIG.saltBytes).toString('hex');
  const hash = crypto.scryptSync(password, salt, HASH_CONFIG.keylen, {
    N: HASH_CONFIG.cost,
    r: HASH_CONFIG.blockSize,
    p: HASH_CONFIG.parallelization,
    maxmem: HASH_CONFIG.maxmem
  }).toString('hex');

  return {
    salt,
    hash,
    formatted: `${salt}:${hash}`
  };
}

/**
 * Verifies a password against a stored hash using constant-time comparison.
 * Supports salt:hash formatted strings, separate salt/hash, and legacy plaintext fallback.
 * @param {string} password - Candidate password
 * @param {string} storedHash - Stored hex hash or 'salt:hash' string or plaintext legacy password
 * @param {string} [storedSalt] - Stored hex salt (optional if storedHash is formatted)
 * @returns {boolean}
 */
function verifyPassword(password, storedHash, storedSalt = null) {
  if (!password || !storedHash) return false;

  let salt = storedSalt;
  let expectedHex = storedHash;

  // 1. Parse formatted salt:hash string
  if (!salt && typeof storedHash === 'string' && storedHash.includes(':')) {
    const parts = storedHash.split(':');
    salt = parts[0];
    expectedHex = parts[1];
  }

  // 2. Handle unhashed legacy plaintext passwords (for seamless on-the-fly migration)
  if (!salt) {
    return password === storedHash;
  }

  // 3. Constant-time scrypt verification
  try {
    const derived = crypto.scryptSync(password, salt, HASH_CONFIG.keylen, {
      N: HASH_CONFIG.cost,
      r: HASH_CONFIG.blockSize,
      p: HASH_CONFIG.parallelization,
      maxmem: HASH_CONFIG.maxmem
    });
    const expected = Buffer.from(expectedHex, 'hex');

    if (derived.length !== expected.length) {
      return false;
    }
    return crypto.timingSafeEqual(derived, expected);
  } catch (err) {
    return false;
  }
}

/**
 * Normalizes any legacy or custom role string into one of the 5 canonical RBAC tiers.
 * @param {string} roleStr
 * @param {boolean} [isAdmin]
 * @returns {string}
 */
function normalizeRole(roleStr, isAdmin) {
  if (isAdmin === true) return ROLES.SUPER_ADMIN;
  if (!roleStr || typeof roleStr !== 'string') return ROLES.EMPLOYEE;

  const lower = roleStr.toLowerCase().trim();
  if (lower.includes('super') || lower === 'super_admin' || lower === 'superadmin') {
    return ROLES.SUPER_ADMIN;
  }
  if (lower.includes('hr') || lower === 'hr_admin' || lower === 'hradmin') {
    return ROLES.HR_ADMIN;
  }
  if (lower.includes('admin') || (lower.includes('lead') && lower.includes('admin'))) {
    return ROLES.SUPER_ADMIN;
  }
  if (lower.includes('manager')) {
    return ROLES.MANAGER;
  }
  if (lower.includes('lead') || lower.includes('leader') || lower === 'team_leader') {
    return ROLES.TEAM_LEADER;
  }
  return ROLES.EMPLOYEE;
}

/**
 * Checks if a user has administrative portal access privileges.
 * @param {object} user
 * @returns {boolean}
 */
function isUserAdmin(user) {
  if (!user) return false;
  if (user.isAdmin === true) return true;
  const role = normalizeRole(user.role, user.isAdmin);
  return role === ROLES.SUPER_ADMIN || role === ROLES.HR_ADMIN || role === ROLES.MANAGER;
}

/**
 * Returns canonical permission array for a given role.
 * @param {string} role
 * @returns {string[]}
 */
function getRolePermissions(role) {
  switch (role) {
    case ROLES.SUPER_ADMIN:
      return [
        'admin:portal_access',
        'users:read', 'users:write', 'users:delete',
        'departments:manage', 'teams:manage', 'shifts:manage',
        'attendance:read_all', 'attendance:write_all',
        'leaves:approve_all', 'corrections:approve_all',
        'audits:read', 'config:manage'
      ];
    case ROLES.HR_ADMIN:
      return [
        'admin:portal_access',
        'users:read', 'users:write',
        'departments:read', 'teams:read', 'shifts:manage',
        'attendance:read_all',
        'leaves:approve_all', 'corrections:approve_all',
        'reports:read'
      ];
    case ROLES.MANAGER:
      return [
        'admin:portal_access',
        'users:read_dept',
        'teams:read_dept',
        'attendance:read_dept',
        'leaves:approve_dept', 'corrections:approve_dept'
      ];
    case ROLES.TEAM_LEADER:
      return [
        'attendance:read_team',
        'leaves:review_team', 'corrections:review_team'
      ];
    case ROLES.EMPLOYEE:
    default:
      return [
        'attendance:self', 'breaks:self',
        'leaves:apply_self', 'corrections:apply_self',
        'profile:read_self'
      ];
  }
}

/**
 * Returns a sanitized copy of the user object with passwords and hashes strictly redacted.
 * @param {object} user
 * @returns {object|null}
 */
function sanitizeUser(user) {
  if (!user) return null;
  const canonicalRole = normalizeRole(user.role, user.isAdmin);
  return {
    id: user.id || null,
    employeeId: user.employee_id || user.employeeId || user.id || null,
    username: user.username,
    displayName: user.display_name || user.displayName || user.username,
    role: canonicalRole,
    departmentId: user.department_id || user.departmentId || null,
    teamId: user.team_id || user.teamId || null,
    department: user.department || 'General',
    team: user.team || 'General Team',
    designation: user.designation || null,
    status: user.status || (user.is_active === 0 ? 'INACTIVE' : 'ACTIVE'),
    joinDate: user.join_date || null,
    email: user.email || null,
    phone: user.phone || null,
    machine: user.machine || null,
    isActive: user.is_active !== undefined ? (user.is_active === 1 || user.is_active === true) : (user.status !== 'Inactive'),
    isAdmin: isUserAdmin(user),
    targetDailyHours: user.target_daily_hours !== undefined ? user.target_daily_hours : (user.targetDailyHours || 8.0),
    idleThresholdSeconds: user.idle_threshold_seconds !== undefined ? user.idle_threshold_seconds : (user.idleThresholdSeconds || 600),
    permissions: getRolePermissions(canonicalRole)
  };
}

/**
 * Creates an authenticated session and returns the session payload.
 * @param {object} user - User record
 * @param {object} [options] - Configuration options
 * @param {boolean} [options.isLegacyAdmin=false] - Generate 'adm_' prefix token
 * @param {number} [options.ttlMs] - Session time to live in milliseconds (default: 24h)
 * @param {string} [options.ip] - Client IP address
 * @param {string} [options.userAgent] - Client User Agent
 * @returns {object}
 */
function createSession(user, options = {}) {
  const isLegacy = options.isLegacyAdmin || false;
  const prefix = isLegacy ? 'adm_' : 'vt_';
  const token = prefix + crypto.randomBytes(isLegacy ? 24 : 32).toString('hex');
  const ttlMs = options.ttlMs || (24 * 60 * 60 * 1000); // 24 hours
  const now = Date.now();
  const expiresAt = now + ttlMs;

  const session = {
    token,
    user: sanitizeUser(user),
    userId: user.id || null,
    ip: options.ip || '127.0.0.1',
    userAgent: options.userAgent || '',
    createdAt: now,
    expiresAt: expiresAt
  };

  sessionCache.set(token, session);
  return session;
}

/**
 * Validates a session token from cache.
 * @param {string} token
 * @returns {object|null}
 */
function validateSession(token) {
  if (!token) return null;
  const session = sessionCache.get(token);
  if (!session) return null;

  if (Date.now() > session.expiresAt) {
    sessionCache.delete(token);
    return null;
  }
  return session;
}

/**
 * Immediately revokes an active session token.
 * @param {string} token
 * @returns {boolean}
 */
function revokeSession(token) {
  if (!token) return false;
  return sessionCache.delete(token);
}

/**
 * Robust multi-source extraction of authentication tokens from HTTP requests.
 * Checks Authorization header (Bearer), X-Admin-Token, X-Auth-Token, URL query, and cookies.
 * @param {import('http').IncomingMessage} req
 * @returns {string} Token or empty string
 */
function extractToken(req) {
  if (!req) return '';

  // 1. Authorization: Bearer <token>
  const authHeader = req.headers?.['authorization'] || '';
  if (authHeader && typeof authHeader === 'string') {
    if (authHeader.startsWith('Bearer ')) {
      return authHeader.slice(7).trim();
    }
    if (!authHeader.includes(' ')) {
      return authHeader.trim();
    }
  }

  // 2. Custom headers: X-Admin-Token or X-Auth-Token
  if (req.headers?.['x-admin-token']) return String(req.headers['x-admin-token']).trim();
  if (req.headers?.['x-auth-token']) return String(req.headers['x-auth-token']).trim();

  // 3. Query parameter: ?token=... or ?auth_token=...
  if (req.url && req.url.includes('?')) {
    try {
      const u = new URL(req.url, 'http://localhost');
      const qToken = u.searchParams.get('token') || u.searchParams.get('auth_token');
      if (qToken) return qToken.trim();
    } catch {}
  }

  // 4. Cookies: vt_session=..., auth_token=..., vt_admin_token=...
  if (req.headers?.['cookie']) {
    const parts = req.headers['cookie'].split(';');
    for (const part of parts) {
      const idx = part.indexOf('=');
      if (idx > -1) {
        const k = part.slice(0, idx).trim();
        const v = part.slice(idx + 1).trim();
        if (k === 'vt_session' || k === 'auth_token' || k === 'vt_admin_token') {
          return decodeURIComponent(v);
        }
      }
    }
  }

  return '';
}

module.exports = {
  HASH_CONFIG,
  ROLES,
  ROLE_HIERARCHY,
  sessionCache,
  hashPassword,
  verifyPassword,
  normalizeRole,
  isUserAdmin,
  getRolePermissions,
  sanitizeUser,
  createSession,
  validateSession,
  revokeSession,
  extractToken
};
