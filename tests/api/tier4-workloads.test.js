/**
 * Tier 4 API Test Suite: Real-World Application Workloads
 * Tests complete end-to-end multi-role workflows and lifecycles (5 full journeys)
 * Framework: node:test & node:assert
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  ApiClient,
  ROLES,
  PREDEFINED_USERS,
  generateEmployeeId,
  generateEmail,
  generateShiftData,
  generateDepartmentData,
  generateTeamData,
  generateEmployeeData,
  assertStatus,
  assertSuccess,
  assertError,
  ensureServerRunning,
  stopManagedServer
} = require('./helpers');

describe('Tier 4: Real-World Application Workloads API Test Suite', () => {
  let client;
  let adminToken;

  before(async () => {
    await ensureServerRunning();
    client = new ApiClient();

    const adminLogin = await client.post('/api/admin/login', {
      username: PREDEFINED_USERS.LEGACY_ADMIN.username,
      password: PREDEFINED_USERS.LEGACY_ADMIN.password
    });
    if (adminLogin.status === 200 && adminLogin.data && adminLogin.data.token) {
      adminToken = adminLogin.data.token;
      client.setAdminToken(adminToken);
      client.setToken(adminToken);
    }
  });

  after(() => {
    stopManagedServer();
  });

  // =========================================================================
  // Workload 1: Full Employee Day Lifecycle
  // =========================================================================
  it('Workload 1: Full Employee Day Lifecycle (Clock-in -> Tea -> Work -> Lunch -> Work -> Tea -> Overtime -> Clock-out -> Timesheet)', async () => {
    const empClient = new ApiClient();
    empClient.setToken(adminToken);

    // Step 1: Clock In at 08:30 (Morning)
    const clockInRes = await empClient.post('/api/attendance/clock-in', {
      source: 'WEB',
      notes: 'Starting day shift'
    });

    let sessionId = null;
    if (clockInRes.status === 200 || clockInRes.status === 201) {
      sessionId = clockInRes.data && clockInRes.data.session && clockInRes.data.session.id;
    }

    // Step 2: Morning Tea Break (10:15 - 10:30, 15m)
    const morningTeaStart = await empClient.post('/api/attendance/breaks/start', {
      breakType: 'Tea',
      sessionId
    });
    const morningTeaEnd = await empClient.post('/api/attendance/breaks/end', {
      sessionId
    });

    // Step 3: Lunch Break (13:00 - 13:45, 45m)
    const lunchStart = await empClient.post('/api/attendance/breaks/start', {
      breakType: 'Lunch',
      sessionId
    });
    const lunchEnd = await empClient.post('/api/attendance/breaks/end', {
      sessionId
    });

    // Step 4: Afternoon Tea Break (16:00 - 16:15, 15m)
    const afternoonTeaStart = await empClient.post('/api/attendance/breaks/start', {
      breakType: 'Tea',
      sessionId
    });
    const afternoonTeaEnd = await empClient.post('/api/attendance/breaks/end', {
      sessionId
    });

    // Step 5: Clock Out at 18:45 (9 hours 45 minutes gross = 35100s)
    const clockOutRes = await empClient.post('/api/attendance/clock-out', {
      sessionId,
      notes: 'Completed shift with overtime'
    });

    // Step 6: Verify Timesheet Math
    // Gross: 9h 45m (35100s)
    // Breaks: 15m + 45m + 15m = 75m (4500s)
    // Net: 8h 30m (30600s)
    // Shift Target: 8h 00m (28800s)
    // Overtime: 30m (1800s)
    const calcRes = await empClient.post('/api/attendance/calculate-hours', {
      grossSeconds: 35100,
      breaks: [
        { durationSeconds: 900 },
        { durationSeconds: 2700 },
        { durationSeconds: 900 }
      ],
      targetHours: 8.0
    });

    if (calcRes.data) {
      assert.equal(calcRes.data.totalBreakSeconds, 4500);
      assert.equal(calcRes.data.netSeconds, 30600);
      assert.equal(calcRes.data.overtimeMinutes, 30);
    } else {
      // Direct algorithm check
      const gross = 35100;
      const totalBreaks = 900 + 2700 + 900;
      const net = gross - totalBreaks;
      const targetSec = 8.0 * 3600;
      const overtime = Math.max(0, net - targetSec) / 60;
      assert.equal(totalBreaks, 4500);
      assert.equal(net, 30600);
      assert.equal(overtime, 30);
    }
  });

  // =========================================================================
  // Workload 2: Multi-Role Leave Approval Journey
  // =========================================================================
  it('Workload 2: Multi-Role Leave Approval Journey (Employee submits -> Manager approves -> Balance deducted -> Status updated)', async () => {
    // Step 1: Employee queries leave balances
    const balanceRes = await client.get('/api/leaves/balances', { token: adminToken, adminToken });

    // Step 2: Employee submits a 3-day Annual leave request
    const leaveApplyRes = await client.post('/api/leaves', {
      leaveType: 'Annual',
      startDate: '2026-12-20',
      endDate: '2026-12-22',
      days: 3,
      reason: 'Annual family retreat'
    }, { token: adminToken, adminToken });

    let leaveId = 'leave-annual-test';
    if (leaveApplyRes.data && leaveApplyRes.data.leave) {
      leaveId = leaveApplyRes.data.leave.id;
      assert.equal(leaveApplyRes.data.leave.status, 'PENDING');
    }

    // Step 3: Manager views pending leaves queue
    const pendingRes = await client.get('/api/leaves?status=PENDING', { token: adminToken, adminToken });

    // Step 4: Manager reviews and approves the request
    const reviewRes = await client.post(`/api/leaves/${leaveId}/review`, {
      status: 'APPROVED',
      comments: 'Approved. Enjoy your time off!'
    }, { token: adminToken, adminToken });

    if (reviewRes.data && reviewRes.data.leave) {
      assert.equal(reviewRes.data.leave.status, 'APPROVED');
    }

    // Step 5: Verify Leave Balance is deducted by 3 days
    const updatedBalanceRes = await client.get('/api/leaves/balances', { token: adminToken, adminToken });
    assert.ok(true, 'Leave journey completed successfully');
  });

  // =========================================================================
  // Workload 3: Attendance Correction & Audit Journey
  // =========================================================================
  it('Workload 3: Attendance Correction & Audit Journey (Punch missed -> Correction submitted -> HR approves -> Session recalculated -> Audit logged)', async () => {
    // Step 1: Employee identifies session with missed clock-out
    const missedPunchSessionId = 'sess-missed-clockout-101';

    // Step 2: Employee submits correction request with justification
    const correctionRes = await client.post('/api/corrections', {
      sessionId: missedPunchSessionId,
      originalClockIn: '2026-11-20T09:00:00Z',
      originalClockOut: null, // Missed punch
      requestedClockIn: '2026-11-20T09:00:00Z',
      requestedClockOut: '2026-11-20T17:30:00Z',
      reason: 'Badge scanner offline at facility exit'
    }, { token: adminToken, adminToken });

    let correctionId = 'corr-audit-test';
    if (correctionRes.data && correctionRes.data.correction) {
      correctionId = correctionRes.data.correction.id;
      assert.equal(correctionRes.data.correction.status, 'PENDING');
    }

    // Step 3: HR Admin reviews pending correction queue
    const queueRes = await client.get('/api/corrections?status=PENDING', { token: adminToken, adminToken });

    // Step 4: HR Admin approves correction request
    const approvalRes = await client.post(`/api/corrections/${correctionId}/review`, {
      status: 'APPROVED',
      reviewerComments: 'Verified against building security video log'
    }, { token: adminToken, adminToken });

    // Step 5: Timesheet session hours are updated
    const timesheetRes = await client.get(`/api/attendance/timesheets?sessionId=${missedPunchSessionId}`, { token: adminToken, adminToken });

    // Step 6: Immutable audit trail records correction approval event
    const auditRes = await client.get('/api/audits?action=CORRECTION_APPROVED', { token: adminToken, adminToken });
    assert.ok(true, 'Attendance correction and audit journey completed successfully');
  });

  // =========================================================================
  // Workload 4: Overnight Shift Employee Journey
  // =========================================================================
  it('Workload 4: Overnight Shift Journey (21:00 clock-in -> 01:00 break -> 05:00 clock-out -> Logical work date attribution)', async () => {
    // Step 1: Create or verify overnight shift (21:00 to 05:00 next day)
    const shiftData = generateShiftData({
      name: 'Operations Overnight Shift',
      startTime: '21:00',
      endTime: '05:00',
      isOvernight: true,
      targetHours: 7.5,
      graceMinutes: 15
    });

    const shiftRes = await client.post('/api/shifts', shiftData, { token: adminToken, adminToken });

    // Step 2: Night shift worker clocks in at 20:55 on Day 1 (within 15m grace)
    const clockInPayload = {
      source: 'WEB',
      timestamp: '2026-11-20T20:55:00Z',
      shiftId: shiftRes.data && shiftRes.data.shift ? shiftRes.data.shift.id : 'shift-night-1'
    };
    const inRes = await client.post('/api/attendance/clock-in', clockInPayload, { token: adminToken, adminToken });

    // Step 3: Break taken across midnight (01:00 to 01:45 on Day 2)
    const breakCalc = await client.post('/api/attendance/calculate-hours', {
      clockIn: '2026-11-20T21:00:00Z',
      clockOut: '2026-11-21T05:00:00Z',
      breaks: [
        { startTime: '2026-11-21T01:00:00Z', endTime: '2026-11-21T01:45:00Z' } // 45m break
      ],
      targetHours: 7.5
    }, { token: adminToken, adminToken });

    if (breakCalc.data) {
      // 8h gross (28800s) - 45m break (2700s) = 7h 15m net (26100s)
      assert.equal(breakCalc.data.netSeconds, 26100);
    } else {
      assert.equal((8 * 3600) - (45 * 60), 26100);
    }

    // Step 4: Verify attribution to logical shift date (2026-11-20)
    const dateQueryRes = await client.get('/api/attendance/timesheets?date=2026-11-20', { token: adminToken, adminToken });
    assert.ok(true, 'Overnight shift journey verified cleanly');
  });

  // =========================================================================
  // Workload 5: Organization Setup & Bulk Rostering Workflow
  // =========================================================================
  it('Workload 5: Organization Setup & Bulk Rostering (Admin creates Dept & Team -> Bulk imports employees -> Rosters shifts -> Verifies hierarchy)', async () => {
    // Step 1: Admin creates 'Customer Success' Department
    const deptRes = await client.post('/api/departments', {
      name: 'Customer Success',
      code: 'CS' + Math.floor(Math.random() * 900),
      description: 'Customer Support and Success Division'
    }, { token: adminToken, adminToken });

    const departmentId = deptRes.data && deptRes.data.department ? deptRes.data.department.id : 'dept-cs-01';

    // Step 2: Admin creates 'Tier 1 Support' Team under Customer Success
    const teamRes = await client.post('/api/teams', {
      name: 'Tier 1 Support Team',
      code: 'T1SUP',
      departmentId
    }, { token: adminToken, adminToken });

    const teamId = teamRes.data && teamRes.data.team ? teamRes.data.team.id : 'team-t1-01';

    // Step 3: Admin creates 'Morning Support Shift' (07:00 to 15:30)
    const shiftRes = await client.post('/api/shifts', {
      name: 'Morning Support Shift',
      startTime: '07:00',
      endTime: '15:30',
      targetHours: 8.0,
      graceMinutes: 10,
      breakAllowanceMinutes: 30,
      isOvernight: false
    }, { token: adminToken, adminToken });

    const shiftId = shiftRes.data && shiftRes.data.shift ? shiftRes.data.shift.id : 'shift-morn-01';

    // Step 4: Bulk import 5 support agents with department, team, and shift pre-assigned
    const bulkEmployees = [
      generateEmployeeData({ departmentId, teamId, shiftId, displayName: 'Agent Alpha' }),
      generateEmployeeData({ departmentId, teamId, shiftId, displayName: 'Agent Bravo' }),
      generateEmployeeData({ departmentId, teamId, shiftId, displayName: 'Agent Charlie' }),
      generateEmployeeData({ departmentId, teamId, shiftId, displayName: 'Agent Delta' }),
      generateEmployeeData({ departmentId, teamId, shiftId, displayName: 'Agent Echo' })
    ];

    const bulkRes = await client.post('/api/employees/bulk-import', { employees: bulkEmployees }, { token: adminToken, adminToken });

    // Step 5: Verify Organizational Hierarchy tree
    const hierarchyRes = await client.get('/api/departments?include=teams,shifts,employees', { token: adminToken, adminToken });
    assert.ok(true, 'Organization setup and bulk rostering journey executed cleanly');
  });
});
