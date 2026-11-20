/**
 * VserveTimeChamp Dedicated Test Suite:
 * Leave Workflows, Punch Corrections, Timesheet Recalculations & Audit Logs (Milestone 3)
 * Pure Node.js (node:test & node:assert)
 * Zero external npm dependencies
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { getDb } = require('../../admin/db/index');
const leaveService = require('../../admin/services/leaveService');
const correctionService = require('../../admin/services/correctionService');
const employeeService = require('../../admin/services/employeeService');
const {
  ApiClient,
  generateEmployeeId,
  generateEmail,
  generateUsername,
  assertStatus,
  assertSuccess,
  ensureServerRunning,
  stopManagedServer
} = require('./helpers');

describe('Milestone 3: Leave Management & Attendance Corrections', () => {
  let client;
  let adminToken;
  let superAdminClient;
  let hrAdminClient;
  let managerClient;
  let employeeClient;

  let testUserId;
  let testSessionId;
  let testLeaveId;
  let testCorrectionId;

  before(async () => {
    await ensureServerRunning();
    client = new ApiClient();
    superAdminClient = new ApiClient();
    hrAdminClient = new ApiClient();
    managerClient = new ApiClient();
    employeeClient = new ApiClient();

    const superRes = await superAdminClient.loginAs('SUPER_ADMIN');
    adminToken = superRes.token;

    await hrAdminClient.loginAs('HR_ADMIN');
    await managerClient.loginAs('MANAGER');
    await employeeClient.loginAs('EMPLOYEE');

    // Create a dedicated test employee in dept-eng
    const emp = employeeService.createEmployee({
      employeeId: generateEmployeeId(),
      username: generateUsername(),
      email: generateEmail(),
      displayName: 'Leave Test User',
      departmentId: 'dept-eng',
      role: 'EMPLOYEE'
    });
    testUserId = emp.id;

    // Create a baseline attendance session with breaks for correction testing
    const db = getDb();
    testSessionId = `sess_corr_${Date.now()}`;
    db.prepare(`
      INSERT INTO attendance_sessions (
        id, user_id, clock_in, clock_out, gross_duration, net_duration,
        overtime_minutes, shortfall_minutes, status, source, created_at
      ) VALUES (?, ?, '2026-11-20T09:00:00Z', '2026-11-20T17:00:00Z', 28800, 25200, 0, 60, 'COMPLETED', 'WEB', datetime('now'))
    `).run(testSessionId, testUserId);

    // Add a 1-hour lunch break to verify break preservation during recalculation
    db.prepare(`
      INSERT INTO attendance_breaks (
        id, session_id, user_id, break_type, start_time, end_time, duration, is_paid, created_at
      ) VALUES (?, ?, ?, 'LUNCH', '2026-11-20T12:00:00Z', '2026-11-20T13:00:00Z', 3600, 0, datetime('now'))
    `).run(`brk_${Date.now()}`, testSessionId, testUserId);
  });

  after(async () => {
    stopManagedServer();
  });

  // =========================================================================
  // 1. Leave Balances & Allocation
  // =========================================================================
  describe('1. Leave Balances & Allocation', () => {
    it('1.1: Retrieves balance breakdown across ANNUAL, SICK, and CASUAL categories', async () => {
      const balances = leaveService.getLeaveBalances(testUserId);
      assert.ok(Array.isArray(balances));
      assert.ok(balances.length >= 3);

      const annual = balances.find(b => b.leaveType === 'ANNUAL');
      const sick = balances.find(b => b.leaveType === 'SICK');
      const casual = balances.find(b => b.leaveType === 'CASUAL');

      assert.ok(annual && annual.remaining > 0);
      assert.ok(sick && sick.remaining > 0);
      assert.ok(casual && casual.remaining > 0);
    });

    it('1.2: GET /api/leaves/balances returns current user leave balances', async () => {
      const res = await superAdminClient.get('/api/leaves/balances');
      assertStatus(res, 200);
      assertSuccess(res);
      assert.ok(res.data.balances || Array.isArray(res.data));
    });
  });

  // =========================================================================
  // 2. Leave Application & Validation
  // =========================================================================
  describe('2. Leave Application & Validation', () => {
    it('2.1: Rejects leave application exceeding available balance with 400 Bad Request', async () => {
      assert.throws(() => {
        leaveService.applyLeave(testUserId, {
          leaveType: 'Casual',
          startDate: '2026-12-01',
          endDate: '2026-12-30',
          days: 50,
          reason: 'Excessive vacation'
        });
      }, (err) => err.statusCode === 400);
    });

    it('2.2: Rejects leave with endDate earlier than startDate with 400', async () => {
      assert.throws(() => {
        leaveService.applyLeave(testUserId, {
          leaveType: 'Sick',
          startDate: '2026-12-10',
          endDate: '2026-12-05',
          days: 2,
          reason: 'Backwards dates'
        });
      }, (err) => err.statusCode === 400);
    });

    it('2.3: Rejects leave with zero or negative days with 400', async () => {
      assert.throws(() => {
        leaveService.applyLeave(testUserId, {
          leaveType: 'Annual',
          startDate: '2026-12-15',
          endDate: '2026-12-16',
          days: 0,
          reason: 'Zero duration'
        });
      }, (err) => err.statusCode === 400);
    });

    it('2.4: Records valid leave request with PENDING status', async () => {
      const leave = leaveService.applyLeave(testUserId, {
        leaveType: 'Annual',
        startDate: '2026-12-24',
        endDate: '2026-12-25',
        days: 2,
        reason: 'Holiday vacation'
      });

      assert.ok(leave && leave.id);
      assert.strictEqual(leave.status, 'PENDING');
      assert.strictEqual(leave.totalDays, 2);
      testLeaveId = leave.id;
    });

    it('2.5: Rejects overlapping leave requests with 409 Conflict', async () => {
      assert.throws(() => {
        leaveService.applyLeave(testUserId, {
          leaveType: 'Sick',
          startDate: '2026-12-24', // Overlaps with 2026-12-24..2026-12-25
          endDate: '2026-12-26',
          days: 3,
          reason: 'Overlapping sickness'
        });
      }, (err) => err.statusCode === 409);
    });
  });

  // =========================================================================
  // 3. Leave Review Workflow & Audit Trail
  // =========================================================================
  describe('3. Leave Review Workflow & Audit Trail', () => {
    it('3.1: Enforces cross-department scoping: Manager in dept-hr cannot approve leave for dept-eng employee (403)', async () => {
      // Mock HR manager reviewer
      const hrManager = { id: 'usr-hr-01', role: 'MANAGER', departmentId: 'dept-hr' };
      assert.throws(() => {
        leaveService.reviewLeave(testLeaveId, hrManager, {
          status: 'APPROVED',
          comments: 'Cross department approval attempt'
        });
      }, (err) => err.statusCode === 403);
    });

    it('3.2: Approves leave, deducts balance, and writes immutable audit log', async () => {
      const beforeBalances = leaveService.getLeaveBalances(testUserId);
      const beforeAnnual = beforeBalances.find(b => b.leaveType === 'ANNUAL');

      // SuperAdmin or valid Department Manager reviews
      const reviewer = { id: 'usr-default', role: 'SUPER_ADMIN' };
      const reviewed = leaveService.reviewLeave(testLeaveId, reviewer, {
        status: 'APPROVED',
        comments: 'Approved by SuperAdmin'
      });

      assert.strictEqual(reviewed.status, 'APPROVED');

      // Verify balance deduction
      const afterBalances = leaveService.getLeaveBalances(testUserId);
      const afterAnnual = afterBalances.find(b => b.leaveType === 'ANNUAL');
      assert.strictEqual(afterAnnual.remaining, beforeAnnual.remaining - 2);
      assert.strictEqual(afterAnnual.used, beforeAnnual.used + 2);

      // Verify immutable audit log entry
      const db = getDb();
      const audit = db.prepare("SELECT * FROM audit_logs WHERE target_id = ? AND action = 'LEAVE_APPROVE'").get(testLeaveId);
      assert.ok(audit, 'Audit log must record LEAVE_APPROVE');
    });

    it('3.3: Rejects reviewing an already approved leave request with 409 Conflict', async () => {
      const reviewer = { id: 'usr-default', role: 'SUPER_ADMIN' };
      assert.throws(() => {
        leaveService.reviewLeave(testLeaveId, reviewer, { status: 'REJECTED' });
      }, (err) => err.statusCode === 409);
    });
  });

  // =========================================================================
  // 4. Attendance Correction Submission & Validation
  // =========================================================================
  describe('4. Attendance Correction Submission & Validation', () => {
    it('4.1: Rejects correction for non-existent session with 404', async () => {
      assert.throws(() => {
        correctionService.submitCorrection(
          { id: testUserId, role: 'EMPLOYEE' },
          { sessionId: 'ghost-sess-999', requestedClockIn: '2026-11-20T09:00:00Z', reason: 'Missing' }
        );
      }, (err) => err.statusCode === 404);
    });

    it('4.2: Rejects correction with requestedClockOut earlier than requestedClockIn with 400', async () => {
      assert.throws(() => {
        correctionService.submitCorrection(
          { id: testUserId, role: 'EMPLOYEE' },
          {
            sessionId: testSessionId,
            requestedClockIn: '2026-11-20T17:00:00Z',
            requestedClockOut: '2026-11-20T09:00:00Z',
            reason: 'Inverted times'
          }
        );
      }, (err) => err.statusCode === 400);
    });

    it('4.3: Rejects distant future punch timestamps with 400', async () => {
      const farFuture = new Date(Date.now() + 86400000 * 30).toISOString();
      assert.throws(() => {
        correctionService.submitCorrection(
          { id: testUserId, role: 'EMPLOYEE' },
          {
            sessionId: testSessionId,
            requestedClockIn: farFuture,
            requestedClockOut: farFuture,
            reason: 'Future punch'
          }
        );
      }, (err) => err.statusCode === 400);
    });

    it('4.4: Prevents employee from submitting correction on another employee session with 403', async () => {
      assert.throws(() => {
        correctionService.submitCorrection(
          { id: 'different-emp-id', role: 'EMPLOYEE' },
          {
            sessionId: testSessionId,
            requestedClockIn: '2026-11-20T09:00:00Z',
            reason: 'Unauthorized attempt'
          }
        );
      }, (err) => err.statusCode === 403);
    });

    it('4.5: Submits valid correction and prevents duplicate pending correction with 409', async () => {
      const correction = correctionService.submitCorrection(
        { id: testUserId, role: 'EMPLOYEE' },
        {
          sessionId: testSessionId,
          requestedClockIn: '2026-11-20T08:30:00Z',
          requestedClockOut: '2026-11-20T18:30:00Z',
          reason: 'System froze during morning punch'
        }
      );

      assert.ok(correction && correction.id);
      assert.strictEqual(correction.status, 'PENDING');
      testCorrectionId = correction.id;

      // Duplicate pending submission throws 409
      assert.throws(() => {
        correctionService.submitCorrection(
          { id: testUserId, role: 'EMPLOYEE' },
          {
            sessionId: testSessionId,
            requestedClockIn: '2026-11-20T08:30:00Z',
            reason: 'Duplicate attempt'
          }
        );
      }, (err) => err.statusCode === 409);
    });
  });

  // =========================================================================
  // 5. Correction Review & Session Recalculation
  // =========================================================================
  describe('5. Correction Review & Session Recalculation', () => {
    it('5.1: Approves correction, retroactively recalculates session hours, preserves recorded breaks, and logs audit', async () => {
      // 08:30 to 18:30 = 10.0 gross hours (36,000s)
      // Preserved break: 1.0 hour lunch (3,600s)
      // Net hours: 9.0 hours (32,400s)
      // Against 8.0 target hours: 60 minutes overtime, 0 shortfall
      const reviewer = { id: 'usr-default', role: 'SUPER_ADMIN' };
      const reviewed = correctionService.reviewCorrection(
        testCorrectionId,
        reviewer,
        { status: 'APPROVED', comments: 'Verified punch logs' }
      );

      assert.strictEqual(reviewed.status, 'APPROVED');

      // Verify attendance session was updated with recalculated values
      const db = getDb();
      const updatedSess = db.prepare('SELECT * FROM attendance_sessions WHERE id = ?').get(testSessionId);
      assert.strictEqual(updatedSess.clock_in, '2026-11-20T08:30:00Z');
      assert.strictEqual(updatedSess.clock_out, '2026-11-20T18:30:00Z');
      assert.strictEqual(updatedSess.gross_duration, 36000);
      assert.strictEqual(updatedSess.net_duration, 32400); // 36000 - 3600
      assert.strictEqual(updatedSess.overtime_minutes, 60);
      assert.strictEqual(updatedSess.shortfall_minutes, 0);

      // Verify break was preserved intact
      const preservedBreak = db.prepare('SELECT * FROM attendance_breaks WHERE session_id = ?').get(testSessionId);
      assert.ok(preservedBreak);
      assert.strictEqual(preservedBreak.duration, 3600);

      // Verify immutable audit log
      const audit = db.prepare("SELECT * FROM audit_logs WHERE target_id = ? AND action = 'CORRECTION_APPROVED'").get(testCorrectionId);
      assert.ok(audit, 'Audit log must record CORRECTION_APPROVED');
    });

    it('5.2: POST /api/corrections/calculate-adjustment returns timesheet adjustment preview', async () => {
      const res = await superAdminClient.post('/api/corrections/calculate-adjustment', {
        requestedClockIn: '2026-11-20T08:00:00Z',
        requestedClockOut: '2026-11-20T17:00:00Z',
        breaks: [
          { startTime: '2026-11-20T12:00:00Z', endTime: '2026-11-20T13:00:00Z' }
        ],
        targetHours: 8.0
      });

      assertStatus(res, 200);
      assertSuccess(res);
      assert.strictEqual(res.data.grossHours, 9);
      assert.strictEqual(res.data.totalBreakHours, 1);
      assert.strictEqual(res.data.netHours, 8);
      assert.strictEqual(res.data.overtimeMinutes, 0);
      assert.strictEqual(res.data.shortfallMinutes, 0);
    });
  });
});
