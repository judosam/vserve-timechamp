/**
 * VserveTimeChamp Automated Test Suite for Milestone 1:
 * Database Engine, Authentication, 5-Tier RBAC Matrix, Data Scoping & Audit Logging
 * Pure Node.js (node:test, node:assert, node:sqlite)
 * Zero external npm dependencies
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const http = require('http');
const { DatabaseSync } = require('node:sqlite');

const { initSchema, seedInitialData } = require('../../admin/db/schema');
const {
  hashPassword,
  verifyPassword,
  normalizeRole,
  isUserAdmin,
  getRolePermissions,
  sanitizeUser,
  createSession,
  validateSession,
  revokeSession,
  extractToken,
  ROLES,
  ROLE_HIERARCHY,
  sessionCache
} = require('../../admin/services/authService');
const { createAuditService, AUDIT_ACTIONS, getClientIp } = require('../../admin/services/auditService');
const { createAuthMiddleware } = require('../../admin/middleware/auth');
const { requireRole, scopeQuery, canAccessUser } = require('../../admin/middleware/rbac');

// Helper to create a mock HTTP Response object
function createMockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers || {};
    },
    end(str) {
      if (str) {
        try {
          this.body = JSON.parse(str);
        } catch {
          this.body = str;
        }
      }
    }
  };
}

// =========================================================================
// SUITE 1: Relational Database Schema & Entities
// =========================================================================
test('Suite 1: Database DDL defines all 11 relational entities', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  initSchema(db);

  const tables = db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC
  `).all().map(r => r.name);

  const requiredTables = [
    'attendance_breaks',
    'attendance_corrections',
    'attendance_sessions',
    'audit_logs',
    'departments',
    'leave_balances',
    'leaves',
    'shift_assignments',
    'shifts',
    'teams',
    'users'
  ];

  for (const table of requiredTables) {
    assert.ok(tables.includes(table), `Table ${table} must exist in database schema`);
  }
  assert.strictEqual(requiredTables.length, 11, 'Must define exactly 11 relational entities');
});

// =========================================================================
// SUITE 2: Partial Unique Indexes & Active Locks
// =========================================================================
test('Suite 2: Partial unique indexes enforce single active session and single open break', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  initSchema(db);

  const now = new Date().toISOString();

  // Create department & user
  db.prepare(`INSERT INTO departments (id, name, code, created_at) VALUES ('d1', 'Eng', 'ENG', ?)`).run(now);
  const p = hashPassword('TestPass@2026');
  db.prepare(`
    INSERT INTO users (id, employee_id, username, password_hash, salt, display_name, role, email, created_at, updated_at)
    VALUES ('u1', 'EMP001', 'test.user', ?, ?, 'Test User', 'EMPLOYEE', 'test@vserve.com', ?, ?)
  `).run(p.hash, p.salt, now, now);

  // 1. First active session succeeds
  db.prepare(`
    INSERT INTO attendance_sessions (id, user_id, clock_in, source, status, created_at)
    VALUES ('s1', 'u1', ?, 'WEB', 'IN_PROGRESS', ?)
  `).run(now, now);

  // 2. Second concurrent active session for same user MUST be rejected by DB partial index
  assert.throws(() => {
    db.prepare(`
      INSERT INTO attendance_sessions (id, user_id, clock_in, source, status, created_at)
      VALUES ('s2', 'u1', ?, 'WEB', 'IN_PROGRESS', ?)
    `).run(now, now);
  }, /UNIQUE constraint failed.*attendance_sessions\.user_id/);

  // 3. Completing the active session allows a new session to be created
  db.prepare(`UPDATE attendance_sessions SET status = 'COMPLETED', clock_out = ? WHERE id = 's1'`).run(now);
  assert.doesNotThrow(() => {
    db.prepare(`
      INSERT INTO attendance_sessions (id, user_id, clock_in, source, status, created_at)
      VALUES ('s3', 'u1', ?, 'WEB', 'IN_PROGRESS', ?)
    `).run(now, now);
  });

  // 4. First open break succeeds
  db.prepare(`
    INSERT INTO attendance_breaks (id, session_id, user_id, break_type, start_time, end_time, created_at)
    VALUES ('b1', 's3', 'u1', 'LUNCH', ?, NULL, ?)
  `).run(now, now);

  // 5. Second concurrent open break on same session MUST be rejected
  assert.throws(() => {
    db.prepare(`
      INSERT INTO attendance_breaks (id, session_id, user_id, break_type, start_time, end_time, created_at)
      VALUES ('b2', 's3', 'u1', 'TEA', ?, NULL, ?)
    `).run(now, now);
  }, /UNIQUE constraint failed.*attendance_breaks\.session_id/);

  // 6. Closing the open break allows a subsequent break to open
  db.prepare(`UPDATE attendance_breaks SET end_time = ? WHERE id = 'b1'`).run(now);
  assert.doesNotThrow(() => {
    db.prepare(`
      INSERT INTO attendance_breaks (id, session_id, user_id, break_type, start_time, end_time, created_at)
      VALUES ('b3', 's3', 'u1', 'TEA', ?, NULL, ?)
    `).run(now, now);
  });
});

// =========================================================================
// SUITE 3: Audit Log Immutability Triggers
// =========================================================================
test('Suite 3: Audit log immutability triggers prevent UPDATE and DELETE', () => {
  const db = new DatabaseSync(':memory:');
  initSchema(db);

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO audit_logs (id, timestamp, user_id, action, target_entity, target_id, details_json, ip_address)
    VALUES ('aud_test_1', ?, NULL, 'CONFIG_UPDATE', 'config', 'default', '{"theme":"dark"}', '127.0.0.1')
  `).run(now);

  // Attempting to UPDATE must fail
  assert.throws(() => {
    db.prepare(`UPDATE audit_logs SET action = 'TAMPERED' WHERE id = 'aud_test_1'`).run();
  }, /immutable and cannot be updated/);

  // Attempting to DELETE must fail
  assert.throws(() => {
    db.prepare(`DELETE FROM audit_logs WHERE id = 'aud_test_1'`).run();
  }, /immutable and cannot be deleted/);

  // Verify the record remained untampered
  const row = db.prepare('SELECT * FROM audit_logs WHERE id = ?').get('aud_test_1');
  assert.strictEqual(row.action, 'CONFIG_UPDATE');
});

// =========================================================================
// SUITE 4: Initial Data Seeding & Migration
// =========================================================================
test('Suite 4: Initial seed populates departments, teams, shifts, users, leave balances, and audit log', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  initSchema(db);
  seedInitialData(db);

  // Verify departments
  const depts = db.prepare('SELECT COUNT(*) as count FROM departments').get();
  assert.strictEqual(depts.count, 4, 'Should seed 4 departments');

  // Verify teams
  const teams = db.prepare('SELECT COUNT(*) as count FROM teams').get();
  assert.strictEqual(teams.count, 4, 'Should seed 4 teams');

  // Verify shifts
  const shifts = db.prepare('SELECT COUNT(*) as count FROM shifts').get();
  assert.strictEqual(shifts.count, 3, 'Should seed 3 shifts (Day, Night, Morning)');

  // Verify seeded users (at least 5: SuperAdmin, Employee, HRAdmin, Manager, TeamLeader)
  const usersCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
  assert.ok(usersCount.count >= 5, 'Should seed at least 5 users across roles');

  // Verify Samuel P has SUPER_ADMIN role
  const samuel = db.prepare("SELECT * FROM users WHERE username = 'Samuel P'").get();
  assert.ok(samuel, 'Samuel P user must exist');
  assert.strictEqual(samuel.role, 'SUPER_ADMIN');
  assert.strictEqual(verifyPassword('Samuel@2026', samuel.password_hash, samuel.salt), true);

  // Verify sarah.m has EMPLOYEE role
  const sarah = db.prepare("SELECT * FROM users WHERE username = 'sarah.m'").get();
  assert.ok(sarah, 'sarah.m user must exist');
  assert.strictEqual(sarah.role, 'EMPLOYEE');
  assert.strictEqual(verifyPassword('Sarah@2026', sarah.password_hash, sarah.salt), true);

  // Verify leave balances for 2026 exist
  const currentYear = new Date().getFullYear();
  const lb = db.prepare('SELECT COUNT(*) as count FROM leave_balances WHERE year = ?').get(currentYear);
  assert.ok(lb.count >= 15, 'Should seed leave balances for all users');

  // Verify initial audit log entry
  const initialAudit = db.prepare("SELECT * FROM audit_logs WHERE action = 'SEED_INITIALIZATION'").get();
  assert.ok(initialAudit, 'SEED_INITIALIZATION audit log must be recorded');
});

// =========================================================================
// SUITE 5: Scrypt Salted Password Hashing & Constant-Time Verification
// =========================================================================
test('Suite 5: Scrypt salted password hashing and constant-time verification', () => {
  const p1 = hashPassword('VserveSecure@2026');
  const p2 = hashPassword('VserveSecure@2026');

  // Must have 16-byte random salt (32 hex) and 64-byte key (128 hex)
  assert.ok(p1.salt && p1.hash);
  assert.strictEqual(p1.salt.length, 32);
  assert.strictEqual(p1.hash.length, 128);

  // Uniqueness of salt and hash across calls
  assert.notStrictEqual(p1.salt, p2.salt);
  assert.notStrictEqual(p1.hash, p2.hash);

  // Correct verification with separate salt/hash
  assert.strictEqual(verifyPassword('VserveSecure@2026', p1.hash, p1.salt), true);
  assert.strictEqual(verifyPassword('WrongPassword', p1.hash, p1.salt), false);
  assert.strictEqual(verifyPassword('', p1.hash, p1.salt), false);
  assert.strictEqual(verifyPassword(null, p1.hash, p1.salt), false);

  // Correct verification with formatted 'salt:hash' string
  assert.strictEqual(verifyPassword('VserveSecure@2026', p1.formatted), true);
  assert.strictEqual(verifyPassword('WrongPassword', p1.formatted), false);

  // Fallback support for unhashed legacy plaintext passwords
  assert.strictEqual(verifyPassword('LegacyPass@123', 'LegacyPass@123'), true);
  assert.strictEqual(verifyPassword('WrongPass', 'LegacyPass@123'), false);
});

// =========================================================================
// SUITE 6: 5-Tier RBAC Role Normalization & Permissions
// =========================================================================
test('Suite 6: 5-tier role normalization, hierarchy, and permissions', () => {
  assert.strictEqual(normalizeRole('Administrator / Lead', true), ROLES.SUPER_ADMIN);
  assert.strictEqual(normalizeRole('super_admin'), ROLES.SUPER_ADMIN);
  assert.strictEqual(normalizeRole('hr_admin'), ROLES.HR_ADMIN);
  assert.strictEqual(normalizeRole('HR Specialist'), ROLES.HR_ADMIN);
  assert.strictEqual(normalizeRole('Engineering Manager'), ROLES.MANAGER);
  assert.strictEqual(normalizeRole('Team Leader'), ROLES.TEAM_LEADER);
  assert.strictEqual(normalizeRole('QA Specialist'), ROLES.EMPLOYEE);
  assert.strictEqual(normalizeRole('Frontend Architect'), ROLES.EMPLOYEE);
  assert.strictEqual(normalizeRole(null), ROLES.EMPLOYEE);

  // Admin access checks
  assert.strictEqual(isUserAdmin({ role: 'SUPER_ADMIN' }), true);
  assert.strictEqual(isUserAdmin({ role: 'HR_ADMIN' }), true);
  assert.strictEqual(isUserAdmin({ role: 'MANAGER' }), true);
  assert.strictEqual(isUserAdmin({ role: 'TEAM_LEADER' }), false);
  assert.strictEqual(isUserAdmin({ role: 'EMPLOYEE' }), false);

  // Permission lists
  const superPerms = getRolePermissions(ROLES.SUPER_ADMIN);
  assert.ok(superPerms.includes('users:delete'));
  assert.ok(superPerms.includes('audits:read'));

  const empPerms = getRolePermissions(ROLES.EMPLOYEE);
  assert.ok(empPerms.includes('attendance:self'));
  assert.strictEqual(empPerms.includes('users:delete'), false);
});

// =========================================================================
// SUITE 7: Credential Sanitization
// =========================================================================
test('Suite 7: Credential sanitization strictly redacts passwords, hashes, and salts', () => {
  const rawUser = {
    id: 'usr-001',
    employee_id: 'EMP001',
    username: 'john.doe',
    password: 'PlainTextPassword123',
    password_hash: 'abc123hash',
    salt: 'deadbeefsalt',
    display_name: 'John Doe',
    role: 'EMPLOYEE',
    department_id: 'dept-eng',
    team_id: 'team-core',
    email: 'john@vserve.com',
    phone: '+1-555-0199',
    is_active: 1
  };

  const sanitized = sanitizeUser(rawUser);

  assert.strictEqual(sanitized.id, 'usr-001');
  assert.strictEqual(sanitized.employeeId, 'EMP001');
  assert.strictEqual(sanitized.username, 'john.doe');
  assert.strictEqual(sanitized.displayName, 'John Doe');
  assert.strictEqual(sanitized.role, 'EMPLOYEE');

  // Verify passwords, hashes, and salts are completely omitted
  assert.strictEqual(sanitized.password, undefined);
  assert.strictEqual(sanitized.password_hash, undefined);
  assert.strictEqual(sanitized.salt, undefined);
});

// =========================================================================
// SUITE 8: Session Management & Multi-source Token Extraction
// =========================================================================
test('Suite 8: Session token creation, validation, expiration, and multi-source extraction', () => {
  const user = { id: 'u1', username: 'samuel.p', role: 'SUPER_ADMIN' };

  // 1. Modern session token (vt_ prefix)
  const session = createSession(user);
  assert.ok(session.token.startsWith('vt_'));
  assert.ok(session.token.length >= 64);
  assert.ok(validateSession(session.token));

  // 2. Legacy admin session token (adm_ prefix)
  const legacySession = createSession(user, { isLegacyAdmin: true });
  assert.ok(legacySession.token.startsWith('adm_'));
  assert.ok(validateSession(legacySession.token));

  // 3. Revocation
  revokeSession(session.token);
  assert.strictEqual(validateSession(session.token), null);

  // 4. Token Extraction: Authorization Bearer
  assert.strictEqual(
    extractToken({ headers: { authorization: `Bearer ${legacySession.token}` } }),
    legacySession.token
  );

  // 5. Token Extraction: X-Admin-Token
  assert.strictEqual(
    extractToken({ headers: { 'x-admin-token': 'adm_custom123' } }),
    'adm_custom123'
  );

  // 6. Token Extraction: X-Auth-Token
  assert.strictEqual(
    extractToken({ headers: { 'x-auth-token': 'vt_custom456' } }),
    'vt_custom456'
  );

  // 7. Token Extraction: Query parameter
  assert.strictEqual(
    extractToken({ headers: {}, url: '/api/feed?token=vt_from_url' }),
    'vt_from_url'
  );

  // 8. Token Extraction: Cookies
  assert.strictEqual(
    extractToken({ headers: { cookie: 'other=1; vt_session=vt_from_cookie; more=2' } }),
    'vt_from_cookie'
  );
});

// =========================================================================
// SUITE 9: Authentication Middleware
// =========================================================================
test('Suite 9: Authentication middleware enforces 401 on missing, expired, or invalid tokens', () => {
  const testSessions = new Map();
  const testUsers = new Map();

  testUsers.set('u_active', { id: 'u_active', username: 'active.user', role: 'EMPLOYEE', is_active: 1 });
  testUsers.set('u_inactive', { id: 'u_inactive', username: 'inactive.user', role: 'EMPLOYEE', is_active: 0 });

  testSessions.set('tok_valid', { token: 'tok_valid', userId: 'u_active', expiresAt: Date.now() + 86400000 });
  testSessions.set('tok_expired', { token: 'tok_expired', userId: 'u_active', expiresAt: Date.now() - 1000 });
  testSessions.set('tok_deactivated', { token: 'tok_deactivated', userId: 'u_inactive', expiresAt: Date.now() + 86400000 });

  const authMw = createAuthMiddleware({
    getSession: tok => testSessions.get(tok) || null,
    getUserById: id => testUsers.get(id) || null
  });

  // 1. Missing token -> 401
  const res1 = createMockRes();
  const user1 = authMw({ headers: {} }, res1);
  assert.strictEqual(user1, null);
  assert.strictEqual(res1.statusCode, 401);
  assert.strictEqual(res1.body.error, 'Unauthorized');

  // 2. Invalid token -> 401
  const res2 = createMockRes();
  const user2 = authMw({ headers: { authorization: 'Bearer invalid_token' } }, res2);
  assert.strictEqual(user2, null);
  assert.strictEqual(res2.statusCode, 401);

  // 3. Expired token -> 401
  const res3 = createMockRes();
  const user3 = authMw({ headers: { authorization: 'Bearer tok_expired' } }, res3);
  assert.strictEqual(user3, null);
  assert.strictEqual(res3.statusCode, 401);

  // 4. Deactivated user -> 401
  const res4 = createMockRes();
  const user4 = authMw({ headers: { authorization: 'Bearer tok_deactivated' } }, res4);
  assert.strictEqual(user4, null);
  assert.strictEqual(res4.statusCode, 401);

  // 5. Valid token -> Success and user attached
  const req5 = { headers: { authorization: 'Bearer tok_valid' } };
  const res5 = createMockRes();
  const user5 = authMw(req5, res5);
  assert.ok(user5);
  assert.strictEqual(user5.username, 'active.user');
  assert.strictEqual(req5.user.username, 'active.user');
  assert.strictEqual(req5.token, 'tok_valid');
});

// =========================================================================
// SUITE 10: 5-Tier RBAC Middleware Gating (403 Forbidden)
// =========================================================================
test('Suite 10: RBAC middleware gates endpoints with 403 Forbidden', () => {
  const superGate = requireRole(['SUPER_ADMIN']);
  const hrGate = requireRole(['SUPER_ADMIN', 'HR_ADMIN']);
  const mgrGate = requireRole(['SUPER_ADMIN', 'HR_ADMIN', 'MANAGER']);
  const leadGate = requireRole(['SUPER_ADMIN', 'HR_ADMIN', 'MANAGER', 'TEAM_LEADER']);

  const reqSuper = { user: { role: 'SUPER_ADMIN' } };
  const reqHR = { user: { role: 'HR_ADMIN' } };
  const reqMgr = { user: { role: 'MANAGER' } };
  const reqLead = { user: { role: 'TEAM_LEADER' } };
  const reqEmp = { user: { role: 'EMPLOYEE' } };

  // Super Admin bypasses all gates
  assert.strictEqual(superGate(reqSuper, createMockRes()), true);
  assert.strictEqual(hrGate(reqSuper, createMockRes()), true);
  assert.strictEqual(mgrGate(reqSuper, createMockRes()), true);
  assert.strictEqual(leadGate(reqSuper, createMockRes()), true);

  // HR Admin can access hrGate, mgrGate, leadGate, but not superGate
  const resHR = createMockRes();
  assert.strictEqual(superGate(reqHR, resHR), false);
  assert.strictEqual(resHR.statusCode, 403);
  assert.strictEqual(resHR.body.error, 'Forbidden');
  assert.strictEqual(hrGate(reqHR, createMockRes()), true);

  // Manager can access mgrGate and leadGate, but not hrGate or superGate
  assert.strictEqual(hrGate(reqMgr, createMockRes()), false);
  assert.strictEqual(mgrGate(reqMgr, createMockRes()), true);

  // Team Leader can access leadGate, but not mgrGate
  assert.strictEqual(mgrGate(reqLead, createMockRes()), false);
  assert.strictEqual(leadGate(reqLead, createMockRes()), true);

  // Employee is blocked by all higher gates
  const resEmp = createMockRes();
  assert.strictEqual(leadGate(reqEmp, resEmp), false);
  assert.strictEqual(resEmp.statusCode, 403);
  assert.strictEqual(resEmp.body.error, 'Forbidden');
});

// =========================================================================
// SUITE 11: Data Scoping Isolation Logic
// =========================================================================
test('Suite 11: Data scoping provides parameterized WHERE clauses per organizational role', () => {
  const superUser = { role: 'SUPER_ADMIN', id: 'u_super' };
  const hrUser = { role: 'HR_ADMIN', id: 'u_hr' };
  const mgrUser = { role: 'MANAGER', id: 'u_mgr', departmentId: 'dept-eng' };
  const leadUser = { role: 'TEAM_LEADER', id: 'u_lead', teamId: 'team-eng-core' };
  const empUser = { role: 'EMPLOYEE', id: 'u_emp' };

  // 1. Super Admin and HR Admin have global access
  assert.strictEqual(scopeQuery(superUser, 'attendance').whereClause, '1 = 1');
  assert.strictEqual(scopeQuery(hrUser, 'attendance').whereClause, '1 = 1');

  // 2. Manager has department-scoped access
  const mScopeAtt = scopeQuery(mgrUser, 'attendance', 'a');
  assert.strictEqual(mScopeAtt.whereClause, 'a.user_id IN (SELECT id FROM users WHERE department_id = ?)');
  assert.deepStrictEqual(mScopeAtt.params, ['dept-eng']);

  const mScopeUser = scopeQuery(mgrUser, 'users', 'u');
  assert.strictEqual(mScopeUser.whereClause, 'u.department_id = ?');
  assert.deepStrictEqual(mScopeUser.params, ['dept-eng']);

  // 3. Team Leader has team-scoped access
  const lScopeAtt = scopeQuery(leadUser, 'attendance', 'a');
  assert.strictEqual(lScopeAtt.whereClause, 'a.user_id IN (SELECT id FROM users WHERE team_id = ?)');
  assert.deepStrictEqual(lScopeAtt.params, ['team-eng-core']);

  const lScopeUser = scopeQuery(leadUser, 'users', 'u');
  assert.strictEqual(lScopeUser.whereClause, 'u.team_id = ?');
  assert.deepStrictEqual(lScopeUser.params, ['team-eng-core']);

  // 4. Employee has self-scoped access
  const eScopeAtt = scopeQuery(empUser, 'attendance', 'a');
  assert.strictEqual(eScopeAtt.whereClause, 'a.user_id = ?');
  assert.deepStrictEqual(eScopeAtt.params, ['u_emp']);

  const eScopeUser = scopeQuery(empUser, 'users', 'u');
  assert.strictEqual(eScopeUser.whereClause, 'u.id = ?');
  assert.deepStrictEqual(eScopeUser.params, ['u_emp']);
});

// =========================================================================
// SUITE 12: Audit Logging Service
// =========================================================================
test('Suite 12: Audit logging service creates immutable records and scopes queries by role', () => {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  const auditService = createAuditService(db);

  const now = new Date().toISOString();
  const p = hashPassword('SuperAdmin@2026');
  db.prepare(`
    INSERT INTO users (id, employee_id, username, password_hash, salt, display_name, role, email, created_at, updated_at)
    VALUES ('u_super', 'EMP001', 'super.admin', ?, ?, 'Super Admin', 'SUPER_ADMIN', 'super@vserve.com', ?, ?)
  `).run(p.hash, p.salt, now, now);

  const req = {
    user: { id: 'u_super', username: 'super.admin' },
    headers: {
      'x-forwarded-for': '198.51.100.42',
      'user-agent': 'VserveAdminBrowser/1.0'
    }
  };

  const logged = auditService.logAuditEvent({
    req,
    action: AUDIT_ACTIONS.USER_CREATE,
    targetEntity: 'users',
    targetId: 'u_new_emp',
    details: {
      username: 'new.employee',
      role: 'EMPLOYEE',
      password: 'cleartext-password-must-be-stripped',
      password_hash: 'hash-must-be-stripped',
      salt: 'salt-must-be-stripped',
      token: 'token-must-be-stripped'
    }
  });

  assert.ok(logged.id.startsWith('aud_'));
  assert.strictEqual(logged.action, AUDIT_ACTIONS.USER_CREATE);
  assert.strictEqual(logged.ipAddress, '198.51.100.42');

  // Verify DB record
  const row = db.prepare('SELECT * FROM audit_logs WHERE id = ?').get(logged.id);
  assert.ok(row);
  assert.strictEqual(row.user_id, 'u_super');

  // Verify all sensitive credential fields are stripped
  const details = JSON.parse(row.details_json);
  assert.strictEqual(details.username, 'new.employee');
  assert.strictEqual(details.password, undefined);
  assert.strictEqual(details.password_hash, undefined);
  assert.strictEqual(details.salt, undefined);
  assert.strictEqual(details.token, undefined);

  // Verify Super Admin can query audit logs
  const superAudit = auditService.getAuditLogs({
    currentUser: { role: 'SUPER_ADMIN' }
  });
  assert.ok(superAudit.total >= 1);
  assert.strictEqual(superAudit.logs[0].action, AUDIT_ACTIONS.USER_CREATE);

  // Verify Employee cannot query audit logs
  const empAudit = auditService.getAuditLogs({
    currentUser: { role: 'EMPLOYEE' }
  });
  assert.strictEqual(empAudit.total, 0);
  assert.strictEqual(empAudit.logs.length, 0);
});

// =========================================================================
// SUITE 13 & 14: HTTP Integration Tests for Auth & RBAC Endpoints
// =========================================================================
function makeHttpRequest({ port, method, path, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { json = data; }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: json
        });
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

test('Suite 13: HTTP Integration: Modern Auth endpoints (/api/auth/*) and Audit Logs', async () => {
  const server = require('../../admin/server');
  const handler = server.listeners('request')[0];
  const testServer = http.createServer(handler);

  await new Promise(resolve => testServer.listen(0, '127.0.0.1', resolve));
  const port = testServer.address().port;

  try {
    // 1. Missing credentials -> 400
    const res1 = await makeHttpRequest({
      port,
      method: 'POST',
      path: '/api/auth/login',
      body: {}
    });
    assert.strictEqual(res1.statusCode, 400);

    // 2. Invalid password -> 401
    const res2 = await makeHttpRequest({
      port,
      method: 'POST',
      path: '/api/auth/login',
      body: { username: 'Samuel P', password: 'WrongPassword' }
    });
    assert.strictEqual(res2.statusCode, 401);
    assert.strictEqual(res2.body.error, 'Invalid credentials');

    // 3. Successful login -> 200 with token and sanitized user
    const res3 = await makeHttpRequest({
      port,
      method: 'POST',
      path: '/api/auth/login',
      body: { username: 'Samuel P', password: 'Samuel@2026' }
    });
    assert.strictEqual(res3.statusCode, 200);
    assert.strictEqual(res3.body.success, true);
    assert.ok(res3.body.token.startsWith('vt_'));
    assert.strictEqual(res3.body.user.role, 'SUPER_ADMIN');
    assert.strictEqual(res3.body.user.password, undefined);
    assert.strictEqual(res3.body.user.password_hash, undefined);

    const superToken = res3.body.token;

    // 4. Employee login -> 200 with EMPLOYEE role
    const resEmp = await makeHttpRequest({
      port,
      method: 'POST',
      path: '/api/auth/login',
      body: { username: 'sarah.m', password: 'Sarah@2026' }
    });
    assert.strictEqual(resEmp.statusCode, 200);
    assert.strictEqual(resEmp.body.user.role, 'EMPLOYEE');
    const empToken = resEmp.body.token;

    // 5. GET /api/auth/me with Super Admin token
    const resMe = await makeHttpRequest({
      port,
      method: 'GET',
      path: '/api/auth/me',
      headers: { authorization: `Bearer ${superToken}` }
    });
    assert.strictEqual(resMe.statusCode, 200);
    assert.strictEqual(resMe.body.user.username, 'Samuel P');

    // 6. GET /api/auth/me without token -> 401
    const resMeUnauth = await makeHttpRequest({
      port,
      method: 'GET',
      path: '/api/auth/me'
    });
    assert.strictEqual(resMeUnauth.statusCode, 401);

    // 7. GET /api/audit/logs with Super Admin token -> 200
    const resAudit = await makeHttpRequest({
      port,
      method: 'GET',
      path: '/api/audit/logs',
      headers: { authorization: `Bearer ${superToken}` }
    });
    assert.strictEqual(resAudit.statusCode, 200);
    assert.strictEqual(resAudit.body.success, true);
    assert.ok(Array.isArray(resAudit.body.logs));

    // 8. GET /api/audit/logs with Employee token -> 403 Forbidden
    const resAuditEmp = await makeHttpRequest({
      port,
      method: 'GET',
      path: '/api/audit/logs',
      headers: { authorization: `Bearer ${empToken}` }
    });
    assert.strictEqual(resAuditEmp.statusCode, 403);
    assert.strictEqual(resAuditEmp.body.error, 'Forbidden');

    // 9. POST /api/auth/logout -> 200
    const resLogout = await makeHttpRequest({
      port,
      method: 'POST',
      path: '/api/auth/logout',
      headers: { authorization: `Bearer ${superToken}` }
    });
    assert.strictEqual(resLogout.statusCode, 200);

    // 10. GET /api/auth/me with revoked token -> 401
    const resMeRevoked = await makeHttpRequest({
      port,
      method: 'GET',
      path: '/api/auth/me',
      headers: { authorization: `Bearer ${superToken}` }
    });
    assert.strictEqual(resMeRevoked.statusCode, 401);
  } finally {
    testServer.close();
  }
});

test('Suite 14: HTTP Integration: Legacy backward compatibility and data protection', async () => {
  const server = require('../../admin/server');
  const handler = server.listeners('request')[0];
  const testServer = http.createServer(handler);

  await new Promise(resolve => testServer.listen(0, '127.0.0.1', resolve));
  const port = testServer.address().port;

  try {
    // 1. POST /api/admin/login without password for default admin (Legacy test runner compatibility)
    const resAdm = await makeHttpRequest({
      port,
      method: 'POST',
      path: '/api/admin/login',
      body: { username: 'Samuel P' }
    });
    assert.strictEqual(resAdm.statusCode, 200);
    assert.ok(resAdm.body.token.startsWith('adm_'));
    const adminToken = resAdm.body.token;

    // 2. POST /api/admin/login for Employee -> 403 Forbidden with exact message
    const resEmpAdm = await makeHttpRequest({
      port,
      method: 'POST',
      path: '/api/admin/login',
      body: { username: 'sarah.m', password: 'Sarah@2026' }
    });
    assert.strictEqual(resEmpAdm.statusCode, 403);
    assert.ok(resEmpAdm.body.error.includes('Access Denied'));

    // 3. GET /api/admin/check with valid admin token -> 200
    const resCheck = await makeHttpRequest({
      port,
      method: 'GET',
      path: '/api/admin/check',
      headers: { 'x-admin-token': adminToken }
    });
    assert.strictEqual(resCheck.statusCode, 200);
    assert.strictEqual(resCheck.body.authenticated, true);

    // 4. GET /api/users with admin token -> 200 sanitized user array
    const resUsers = await makeHttpRequest({
      port,
      method: 'GET',
      path: '/api/users',
      headers: { 'x-admin-token': adminToken }
    });
    assert.strictEqual(resUsers.statusCode, 200);
    assert.ok(Array.isArray(resUsers.body));
    for (const u of resUsers.body) {
      assert.strictEqual(u.password, undefined);
      assert.strictEqual(u.password_hash, undefined);
      assert.strictEqual(u.salt, undefined);
    }

    // 5. POST /api/client/login -> 200 with sanitized user (no plaintext password/hash exposed)
    const resClientLogin = await makeHttpRequest({
      port,
      method: 'POST',
      path: '/api/client/login',
      body: { username: 'sarah.m', password: 'Sarah@2026' }
    });
    assert.strictEqual(resClientLogin.statusCode, 200);
    assert.strictEqual(resClientLogin.body.success, true);
    assert.strictEqual(resClientLogin.body.user.username, 'sarah.m');
    assert.strictEqual(resClientLogin.body.user.password, undefined);
    assert.strictEqual(resClientLogin.body.user.password_hash, undefined);
    assert.strictEqual(resClientLogin.body.user.salt, undefined);
    assert.ok(resClientLogin.body.serverTime);
    assert.ok(resClientLogin.body.config);

    // 6. POST /api/admin/logout -> 200
    const resAdmLogout = await makeHttpRequest({
      port,
      method: 'POST',
      path: '/api/admin/logout',
      headers: { 'x-admin-token': adminToken }
    });
    assert.strictEqual(resAdmLogout.statusCode, 200);

    // 7. GET /api/admin/check after logout -> 401
    const resCheckAfter = await makeHttpRequest({
      port,
      method: 'GET',
      path: '/api/admin/check',
      headers: { 'x-admin-token': adminToken }
    });
    assert.strictEqual(resCheckAfter.statusCode, 401);
  } finally {
    testServer.close();
  }
});
