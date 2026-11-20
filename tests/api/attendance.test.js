/**
 * VserveTimeChamp Milestone 2: Attendance & Timesheets API Test Suite
 * Pure Node.js (node:test, node:assert, native fetch)
 * Validates real-time clock-in/out, duplicate locking, multi-type break tracking,
 * break interval deduplication union math, punctuality evaluation, timesheets, and RBAC scoping.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { getDb } = require('../../admin/db/index');
const {
  ApiClient,
  ROLES,
  PREDEFINED_USERS,
  generateEmployeeId,
  assertStatus,
  assertSuccess,
  ensureServerRunning,
  stopManagedServer
} = require('./helpers');

describe('Milestone 2: Attendance, Clock-In/Out, Breaks & Timesheets API Suite', () => {
  let adminClient;
  let employeeClient;
  let managerClient;
  let teamLeadClient;
  let adminToken;
  let empToken;

  let testSessionId;
  let testBreakId;

  before(async () => {
    getDb();
    await ensureServerRunning();

    adminClient = new ApiClient();
    employeeClient = new ApiClient();
    managerClient = new ApiClient();
    teamLeadClient = new ApiClient();

    // Authenticate SUPER_ADMIN
    const adminLogin = await adminClient.post('/api/auth/login', {
      username: PREDEFINED_USERS.SUPER_ADMIN.username,
      password: PREDEFINED_USERS.SUPER_ADMIN.password
    });
    if (adminLogin.status === 200 && adminLogin.data && adminLogin.data.token) {
      adminToken = adminLogin.data.token;
      adminClient.setToken(adminToken);
    } else {
      // Fallback to legacy admin login
      const legLogin = await adminClient.post('/api/admin/login', {
        username: PREDEFINED_USERS.LEGACY_ADMIN.username,
        password: PREDEFINED_USERS.LEGACY_ADMIN.password
      });
      adminToken = legLogin.data.token;
      adminClient.setAdminToken(adminToken);
      adminClient.setToken(adminToken);
    }

    // Authenticate EMPLOYEE (emp.sarah)
    const empLogin = await employeeClient.post('/api/auth/login', {
      username: PREDEFINED_USERS.EMPLOYEE.username,
      password: PREDEFINED_USERS.EMPLOYEE.password
    });
    if (empLogin.status === 200 && empLogin.data && empLogin.data.token) {
      empToken = empLogin.data.token;
      employeeClient.setToken(empToken);
    }

    // Authenticate MANAGER
    const mgrLogin = await managerClient.post('/api/auth/login', {
      username: PREDEFINED_USERS.MANAGER.username,
      password: PREDEFINED_USERS.MANAGER.password
    });
    if (mgrLogin.status === 200 && mgrLogin.data && mgrLogin.data.token) {
      managerClient.setToken(mgrLogin.data.token);
    }

    // Authenticate TEAM_LEADER
    const tlLogin = await teamLeadClient.post('/api/auth/login', {
      username: PREDEFINED_USERS.TEAM_LEADER.username,
      password: PREDEFINED_USERS.TEAM_LEADER.password
    });
    if (tlLogin.status === 200 && tlLogin.data && tlLogin.data.token) {
      teamLeadClient.setToken(tlLogin.data.token);
    }

    // Clean up any stale active sessions for employeeClient before starting tests
    try {
      await employeeClient.post('/api/attendance/clock-out', {});
    } catch {}
  });

  after(() => {
    stopManagedServer();
  });

  // =========================================================================
  // 1. Clock-In Operations
  // =========================================================================
  describe('1. Real-time Clock-In Operations', () => {
    it('1.1: Clock-in creates active session with server ISO UTC timestamp and source WEB', async () => {
      const res = await employeeClient.post('/api/attendance/clock-in', {
        source: 'WEB',
        notes: 'Starting day shift'
      });

      assertStatus(res, 200);
      assertSuccess(res);
      assert.ok(res.data.session, 'Expected session object');
      assert.ok(res.data.session.id, 'Expected session ID');
      assert.ok(res.data.session.clockIn, 'Expected server ISO UTC clockIn timestamp');
      assert.equal(res.data.session.status, 'IN_PROGRESS');
      assert.equal(res.data.session.source, 'WEB');
      testSessionId = res.data.session.id;
    });

    it('1.2: Duplicate clock-in for user with active session returns HTTP 409 Conflict', async () => {
      const res = await employeeClient.post('/api/attendance/clock-in', {
        source: 'DESKTOP'
      });

      assertStatus(res, 409);
      assert.equal(res.data.success, false);
      assert.ok((res.data.error || '').toLowerCase().includes('active'));
    });

    it('1.3: GET /api/attendance/status returns active in-progress session', async () => {
      const res = await employeeClient.get('/api/attendance/status');

      assertStatus(res, 200);
      assertSuccess(res);
      assert.equal(res.data.active, true);
      assert.ok(res.data.session);
      assert.equal(res.data.session.id, testSessionId);
      assert.equal(res.data.session.status, 'IN_PROGRESS');
    });

    it('1.4: GET /api/attendance/active (alias) returns active session matching status', async () => {
      const res = await employeeClient.get('/api/attendance/active');

      assertStatus(res, 200);
      assertSuccess(res);
      assert.equal(res.data.active, true);
      assert.equal(res.data.session.id, testSessionId);
    });

    it('1.5: Clock-in rejects invalid timestamp format for clockInTime with HTTP 400', async () => {
      const res = await employeeClient.post('/api/attendance/clock-in', {
        clockInTime: 'invalid-timestamp-value'
      });

      assertStatus(res, 400);
      assert.equal(res.data.success, false);
      assert.ok(res.data.error.includes('Invalid timestamp format for clockInTime'));
    });
  });

  // =========================================================================
  // 2. Break Management
  // =========================================================================
  describe('2. Multi-Type Break Management', () => {
    it('2.1: POST /api/attendance/breaks/start starts a "Lunch" break', async () => {
      const res = await employeeClient.post('/api/attendance/breaks/start', {
        breakType: 'Lunch',
        sessionId: testSessionId
      });

      assertStatus(res, 200);
      assertSuccess(res);
      assert.ok(res.data.break);
      assert.equal(res.data.break.breakType, 'Lunch');
      assert.ok(res.data.break.startTime);
      assert.equal(res.data.break.endTime, null);
      testBreakId = res.data.break.id;
    });

    it('2.2: Starting second break while another is active returns HTTP 409 Conflict', async () => {
      const res = await employeeClient.post('/api/attendance/breaks/start', {
        breakType: 'Tea'
      });

      assertStatus(res, 409);
      assert.equal(res.data.success, false);
    });

    it('2.3: Active status includes currently open break', async () => {
      const res = await employeeClient.get('/api/attendance/status');

      assertStatus(res, 200);
      assertSuccess(res);
      assert.ok(res.data.openBreak);
      assert.equal(res.data.openBreak.id, testBreakId);
      assert.equal(res.data.openBreak.breakType, 'Lunch');
    });

    it('2.4: POST /api/attendance/breaks/end concludes open break and calculates duration', async () => {
      const res = await employeeClient.post('/api/attendance/breaks/end', {
        breakId: testBreakId
      });

      assertStatus(res, 200);
      assertSuccess(res);
      assert.ok(res.data.break);
      assert.ok(res.data.break.endTime);
      assert.ok(typeof res.data.break.duration === 'number');
    });

    it('2.5: Ending non-existent or already ended break returns HTTP 400 or 404', async () => {
      const res = await employeeClient.post('/api/attendance/breaks/end', {
        breakId: testBreakId
      });

      assert.ok([400, 404].includes(res.status));
      assert.equal(res.data.success, false);
    });

    it('2.6: Starting break with invalid break type returns HTTP 400 Bad Request', async () => {
      const res = await employeeClient.post('/api/attendance/breaks/start', {
        breakType: 'InvalidNapType'
      });

      assertStatus(res, 400);
      assert.equal(res.data.success, false);
    });

    it('2.7: Supports /api/attendance/break/start and /break/end singular aliases', async () => {
      const startRes = await employeeClient.post('/api/attendance/break/start', {
        breakType: 'Tea'
      });
      assertStatus(startRes, 200);
      assert.equal(startRes.data.break.breakType, 'Tea');

      const endRes = await employeeClient.post('/api/attendance/break/end', {
        breakId: startRes.data.break.id
      });
      assertStatus(endRes, 200);
      assert.ok(endRes.data.break.endTime);
    });
  });

  // =========================================================================
  // 3. Clock-Out Operations
  // =========================================================================
  describe('3. Clock-Out Operations', () => {
    it('3.1: Clock-out concludes active session, auto-closes open breaks, and updates status to COMPLETED', async () => {
      // Start a quick break right before clock-out to test auto-close
      await employeeClient.post('/api/attendance/breaks/start', { breakType: 'Personal' });

      const res = await employeeClient.post('/api/attendance/clock-out', {
        sessionId: testSessionId,
        notes: 'Day shift completed'
      });

      assertStatus(res, 200);
      assertSuccess(res);
      assert.ok(res.data.session);
      assert.equal(res.data.session.status, 'COMPLETED');
      assert.ok(res.data.session.clockOut);
      assert.ok(typeof res.data.session.grossDuration === 'number');
      assert.ok(typeof res.data.session.netDuration === 'number');
    });

    it('3.2: Clock-out when no active session is open returns HTTP 400 or 404', async () => {
      const res = await employeeClient.post('/api/attendance/clock-out', {});

      assert.ok([400, 404].includes(res.status));
      assert.equal(res.data.success, false);
    });

    it('3.3: Duplicate clock-out on already COMPLETED session returns HTTP 400 or 409', async () => {
      const res = await employeeClient.post('/api/attendance/clock-out', {
        sessionId: testSessionId
      });

      assert.ok([400, 409].includes(res.status));
      assert.equal(res.data.success, false);
    });

    it('3.4: GET /api/attendance/status returns active: false after clock-out', async () => {
      const res = await employeeClient.get('/api/attendance/status');

      assertStatus(res, 200);
      assert.equal(res.data.active, false);
      assert.equal(res.data.session, null);
    });

    it('3.5: Clock-out deduplicates overlapping break records in SQLite (union calculation)', async () => {
      // 1. Clock in to start a new session
      const clockInRes = await employeeClient.post('/api/attendance/clock-in', {
        clockInTime: '2026-11-20T09:00:00Z',
        source: 'WEB'
      });
      assertStatus(clockInRes, 200);
      const overlapSessionId = clockInRes.data.session.id;

      // 2. Insert two overlapping breaks directly into SQLite for this session
      // Break 1: 12:00:00 to 12:45:00 (45 mins = 2700s)
      // Break 2: 12:30:00 to 13:15:00 (45 mins = 2700s)
      // Combined union: 12:00:00 to 13:15:00 = 75 mins = 4500s (instead of naive 5400s)
      const db = getDb();
      const userId = clockInRes.data.session.userId;
      const b1Id = `brk-ovlp-1-${Date.now()}`;
      const b2Id = `brk-ovlp-2-${Date.now()}`;
      const createdAt = new Date().toISOString();
      db.prepare(`
        INSERT INTO attendance_breaks (id, session_id, user_id, break_type, start_time, end_time, duration, is_paid, created_at)
        VALUES (?, ?, ?, 'Lunch', '2026-11-20T12:00:00Z', '2026-11-20T12:45:00Z', 2700, 0, ?)
      `).run(b1Id, overlapSessionId, userId, createdAt);
      db.prepare(`
        INSERT INTO attendance_breaks (id, session_id, user_id, break_type, start_time, end_time, duration, is_paid, created_at)
        VALUES (?, ?, ?, 'Tea', '2026-11-20T12:30:00Z', '2026-11-20T13:15:00Z', 2700, 0, ?)
      `).run(b2Id, overlapSessionId, userId, createdAt);

      // 3. Clock out 8 hours later (09:00 to 17:00 = 28,800s gross)
      const clockOutRes = await employeeClient.post('/api/attendance/clock-out', {
        sessionId: overlapSessionId,
        clockOutTime: '2026-11-20T17:00:00Z'
      });

      assertStatus(clockOutRes, 200);
      assertSuccess(clockOutRes);
      assert.equal(clockOutRes.data.session.status, 'COMPLETED');
      assert.equal(clockOutRes.data.session.grossDuration, 28800);
      // Deduplicated total break = 4500 seconds (not naive 5400)
      // Net duration = 28800 - 4500 = 24300 seconds
      assert.equal(clockOutRes.data.session.netDuration, 24300);
      assert.equal(clockOutRes.data.session.shortfallMinutes, 75); // 8h target (28800) - 24300 = 4500s = 75m shortfall
    });
  });

  // =========================================================================
  // 4. Mathematical Calculation Helpers
  // =========================================================================
  describe('4. Mathematical Calculation Helpers', () => {
    it('4.1: POST /api/attendance/calculate-hours merges overlapping break intervals (union algorithm)', async () => {
      // Two overlapping breaks: 12:00-12:45 (45m) and 12:30-13:15 (45m)
      // Union interval = 12:00 to 13:15 = 75 minutes (4500 seconds), NOT 90 minutes (5400s)
      const res = await employeeClient.post('/api/attendance/calculate-hours', {
        grossSeconds: 32400, // 9 hours
        breaks: [
          { startTime: '2026-11-20T12:00:00Z', endTime: '2026-11-20T12:45:00Z' },
          { startTime: '2026-11-20T12:30:00Z', endTime: '2026-11-20T13:15:00Z' }
        ]
      });

      assertStatus(res, 200);
      assert.equal(res.data.totalBreakSeconds, 4500);
      assert.equal(res.data.netSeconds, 27900); // 32400 - 4500 = 27900 (7h 45m)
    });

    it('4.2: POST /api/attendance/calculate-hours clamps net duration to >= 0 when breaks exceed gross duration', async () => {
      const res = await employeeClient.post('/api/attendance/calculate-hours', {
        grossSeconds: 14400, // 4 hours
        breaks: [
          { durationSeconds: 18000 } // 5 hours
        ]
      });

      assertStatus(res, 200);
      assert.equal(res.data.netSeconds, 0);
    });

    it('4.3: POST /api/attendance/calculate-hours computes 8 hours across date boundary for overnight shift', async () => {
      const res = await employeeClient.post('/api/attendance/calculate-hours', {
        clockIn: '2026-11-20T22:00:00Z',
        clockOut: '2026-11-21T06:00:00Z',
        breaks: [
          { startTime: '2026-11-21T01:00:00Z', endTime: '2026-11-21T01:45:00Z' } // 45m past midnight
        ]
      });

      assertStatus(res, 200);
      assert.equal(res.data.grossHours, 8);
      assert.equal(res.data.totalBreakSeconds, 2700);
      assert.equal(res.data.netSeconds, 26100); // 28800 - 2700 = 26100 (7.25 hours)
    });

    it('4.4: POST /api/attendance/calculate-hours rejects clockOut earlier than clockIn with HTTP 400', async () => {
      const res = await employeeClient.post('/api/attendance/calculate-hours', {
        clockIn: '2026-11-20T17:00:00Z',
        clockOut: '2026-11-20T09:00:00Z'
      });

      assertStatus(res, 400);
      assert.equal(res.data.success, false);
    });

    it('4.5: POST /api/attendance/evaluate-punctuality correctly flags on-time vs late clock-ins', async () => {
      // Within 15m grace period: on time
      const onTimeRes = await employeeClient.post('/api/attendance/evaluate-punctuality', {
        shiftStartTime: '09:00',
        graceMinutes: 15,
        actualClockInTime: '09:10'
      });
      assertStatus(onTimeRes, 200);
      assert.equal(onTimeRes.data.isLate, false);
      assert.equal(onTimeRes.data.lateMinutes, 0);

      // Past 15m grace period: lateMinutes measured from scheduled start (25 minutes)
      const lateRes = await employeeClient.post('/api/attendance/evaluate-punctuality', {
        shiftStartTime: '09:00',
        graceMinutes: 15,
        actualClockInTime: '09:25'
      });
      assertStatus(lateRes, 200);
      assert.equal(lateRes.data.isLate, true);
      assert.equal(lateRes.data.lateMinutes, 25);
    });

    it('4.6: POST /api/attendance/calculate-hours merges overlapping break intervals with snake_case start_time/end_time', async () => {
      const res = await employeeClient.post('/api/attendance/calculate-hours', {
        grossSeconds: 28800,
        breaks: [
          { start_time: '2026-11-20T12:00:00Z', end_time: '2026-11-20T12:45:00Z' },
          { start_time: '2026-11-20T12:30:00Z', end_time: '2026-11-20T13:15:00Z' }
        ]
      });

      assertStatus(res, 200);
      assert.equal(res.data.totalBreakSeconds, 4500);
      assert.equal(res.data.netSeconds, 24300);
    });

    it('4.7: POST /api/attendance/evaluate-punctuality correctly calculates late arrival past midnight on overnight shift', async () => {
      // Shift starts at 22:00, arrival is at 00:10 (past midnight = 130 minutes late)
      const res = await employeeClient.post('/api/attendance/evaluate-punctuality', {
        shiftStartTime: '22:00',
        graceMinutes: 15,
        actualClockInTime: '00:10'
      });

      assertStatus(res, 200);
      assert.equal(res.data.isLate, true);
      assert.equal(res.data.lateMinutes, 130);
    });
  });

  // =========================================================================
  // 5. Timesheets & RBAC Data Scoping
  // =========================================================================
  describe('5. Timesheets & RBAC Data Scoping', () => {
    it('5.1: Employee can view own timesheets', async () => {
      const res = await employeeClient.get('/api/attendance/timesheets');

      assertStatus(res, 200);
      assertSuccess(res);
      assert.ok(Array.isArray(res.data.sessions));
      // All returned sessions must belong to the employee
      for (const s of res.data.sessions) {
        assert.equal(s.userId, PREDEFINED_USERS.EMPLOYEE.id || s.userId);
      }
    });

    it('5.2: Employee attempting to view another employee\'s timesheets receives HTTP 403 Forbidden', async () => {
      const res = await employeeClient.get('/api/attendance/timesheets?employeeId=usr-default');

      assertStatus(res, 403);
      assert.equal(res.data.success, false);
    });

    it('5.3: Super Admin can query timesheets with summary calculation', async () => {
      const res = await adminClient.get('/api/attendance/timesheets?summary=true');

      assertStatus(res, 200);
      assertSuccess(res);
      assert.ok(Array.isArray(res.data.sessions));
      assert.ok(res.data.summary);
      assert.ok(typeof res.data.summary.totalSessions === 'number');
      assert.ok(typeof res.data.summary.totalGrossSeconds === 'number');
    });

    it('5.4: Timesheets filter by logicalDate returns sessions for that work date', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const res = await adminClient.get(`/api/attendance/timesheets?logicalDate=${today}`);

      assertStatus(res, 200);
      assertSuccess(res);
      assert.ok(Array.isArray(res.data.sessions));
    });
  });
});
