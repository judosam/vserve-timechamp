/**
 * VserveTimeChamp Dedicated Test Suite:
 * Employee, Department, Team, Shift & Roster Management (Milestone 3)
 * Pure Node.js (node:test & node:assert)
 * Zero external npm dependencies
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { getDb } = require('../../admin/db/index');
const employeeService = require('../../admin/services/employeeService');
const shiftService = require('../../admin/services/shiftService');
const {
  ApiClient,
  ROLES,
  generateEmployeeId,
  generateEmail,
  generateUsername,
  generateShiftData,
  generateDepartmentData,
  generateTeamData,
  generateEmployeeData,
  assertStatus,
  assertSuccess,
  ensureServerRunning,
  stopManagedServer
} = require('./helpers');

describe('Milestone 3: Employee, Department, Team & Shift Management', () => {
  let client;
  let adminToken;
  let superAdminClient;
  let hrAdminClient;
  let managerClient;
  let teamLeaderClient;
  let employeeClient;

  let testDeptId;
  let testTeamId;
  let testShiftId;
  let createdEmpId;

  before(async () => {
    await ensureServerRunning();
    client = new ApiClient();
    superAdminClient = new ApiClient();
    hrAdminClient = new ApiClient();
    managerClient = new ApiClient();
    teamLeaderClient = new ApiClient();
    employeeClient = new ApiClient();

    const superRes = await superAdminClient.loginAs('SUPER_ADMIN');
    assert.ok(superRes.token, 'Super admin login required');
    adminToken = superRes.token;

    await hrAdminClient.loginAs('HR_ADMIN');
    await managerClient.loginAs('MANAGER');
    await teamLeaderClient.loginAs('TEAM_LEADER');
    await employeeClient.loginAs('EMPLOYEE');
  });

  after(async () => {
    stopManagedServer();
  });

  // =========================================================================
  // 1. Employee CRUD & Validation
  // =========================================================================
  describe('1. Employee CRUD & Validation', () => {
    it('1.1: Rejects employee creation when required fields are missing', async () => {
      assert.throws(() => {
        employeeService.createEmployee({});
      }, (err) => err.statusCode === 400);

      assert.throws(() => {
        employeeService.createEmployee({ username: 'missing_id', email: 'missing@example.com' });
      }, (err) => err.statusCode === 400);
    });

    it('1.2: Rejects employee creation with invalid email format', async () => {
      assert.throws(() => {
        employeeService.createEmployee({
          employeeId: generateEmployeeId(),
          username: generateUsername(),
          email: 'not-a-valid-email'
        });
      }, (err) => err.statusCode === 400);
    });

    it('1.3: Creates employee and enforces strict credential sanitization (no leak of hash/salt/password)', async () => {
      const empData = {
        employeeId: generateEmployeeId(),
        username: generateUsername(),
        email: generateEmail(),
        password: 'SecurePassword@2026',
        displayName: 'Test Sanitize User',
        role: 'EMPLOYEE',
        designation: 'Software Engineer',
        phone: '+1-555-8888'
      };

      const res = await superAdminClient.post('/api/employees', empData);
      assert.ok(res.status === 200 || res.status === 201);
      assertSuccess(res);
      assert.ok(res.data.employee);
      createdEmpId = res.data.employee.id;

      // Confidentiality check: password, password_hash, salt must NEVER be exposed
      assert.strictEqual(res.data.employee.password, undefined);
      assert.strictEqual(res.data.employee.passwordHash, undefined);
      assert.strictEqual(res.data.employee.password_hash, undefined);
      assert.strictEqual(res.data.employee.salt, undefined);
    });

    it('1.4: Rejects duplicate employee_id, email, and username with 409 Conflict', async () => {
      const existing = employeeService.getEmployeeById(createdEmpId);

      // Duplicate employeeId
      assert.throws(() => {
        employeeService.createEmployee({
          employeeId: existing.employeeId,
          username: generateUsername(),
          email: generateEmail()
        });
      }, (err) => err.statusCode === 409);

      // Duplicate email
      assert.throws(() => {
        employeeService.createEmployee({
          employeeId: generateEmployeeId(),
          username: generateUsername(),
          email: existing.email
        });
      }, (err) => err.statusCode === 409);

      // Duplicate username
      assert.throws(() => {
        employeeService.createEmployee({
          employeeId: generateEmployeeId(),
          username: existing.username,
          email: generateEmail()
        });
      }, (err) => err.statusCode === 409);
    });

    it('1.5: Retrieves full employee profile by ID and supports role scoping', async () => {
      const res = await superAdminClient.get(`/api/employees/${createdEmpId}`);
      assertStatus(res, 200);
      assert.strictEqual(res.data.employee.id, createdEmpId);
      assert.ok(res.data.employee.leaveBalances);

      // Employee cannot access another employee's private profile (403)
      const empRes = await employeeClient.get(`/api/employees/${createdEmpId}`);
      assert.ok([403, 404].includes(empRes.status));
    });

    it('1.6: Updates employee details and enforces uniqueness conflict detection', async () => {
      const otherEmp = employeeService.createEmployee({
        employeeId: generateEmployeeId(),
        username: generateUsername(),
        email: generateEmail(),
        displayName: 'Other Employee'
      });

      // Updating to another user's email throws 409
      assert.throws(() => {
        employeeService.updateEmployee(createdEmpId, { email: otherEmp.email });
      }, (err) => err.statusCode === 409);

      // Successful update
      const updated = employeeService.updateEmployee(createdEmpId, {
        displayName: 'Updated Engineer Name',
        designation: 'Senior Engineer'
      });
      assert.strictEqual(updated.displayName, 'Updated Engineer Name');
      assert.strictEqual(updated.designation, 'Senior Engineer');
    });

    it('1.7: Soft-deactivates employee and auto-closes active session when requested', async () => {
      const db = getDb();
      // Clock in the employee first
      const sessId = `sess_test_${Date.now()}`;
      db.prepare(`
        INSERT INTO attendance_sessions (id, user_id, clock_in, status, source, created_at)
        VALUES (?, ?, datetime('now'), 'IN_PROGRESS', 'API', datetime('now'))
      `).run(sessId, createdEmpId);

      const res = await superAdminClient.delete(`/api/employees/${createdEmpId}?autoClockOut=true`);
      assertStatus(res, 200);

      // Verify soft deactivation
      const deactivated = db.prepare('SELECT is_active, status FROM users WHERE id = ?').get(createdEmpId);
      assert.strictEqual(deactivated.is_active, 0);

      // Verify active session was auto-closed
      const sess = db.prepare('SELECT status, clock_out FROM attendance_sessions WHERE id = ?').get(sessId);
      assert.ok(['COMPLETED', 'AUTO_CLOSED'].includes(sess.status));
      assert.ok(sess.clock_out);
    });
  });

  // =========================================================================
  // 2. Bulk Employee Import
  // =========================================================================
  describe('2. Bulk Employee Import', () => {
    it('2.1: Dry-run mode validates rows without writing to database', async () => {
      const dryRunPayload = {
        dryRun: true,
        employees: [
          generateEmployeeData(),
          generateEmployeeData()
        ]
      };

      const res = await superAdminClient.post('/api/employees/bulk-import', dryRunPayload);
      assertStatus(res, 200);
      assert.strictEqual(res.data.dryRun, true);
      assert.strictEqual(res.data.inserted, 0);
      assert.strictEqual(res.data.total, 2);
    });

    it('2.2: Reports line-item errors for invalid records (invalid email, missing ID)', async () => {
      const mixedPayload = {
        employees: [
          generateEmployeeData(), // valid
          { employeeId: '', email: 'no-id@test.com' }, // missing employeeId
          { employeeId: generateEmployeeId(), email: 'bad-email-format' } // invalid email
        ]
      };

      const res = await superAdminClient.post('/api/employees/bulk-import', mixedPayload);
      assertStatus(res, 200);
      assert.strictEqual(res.data.inserted, 1);
      assert.strictEqual(res.data.failed, 2);
      assert.ok(Array.isArray(res.data.errors) && res.data.errors.length === 2);
    });

    it('2.3: Supports CSV string bulk import and automatically links defaultShiftId', async () => {
      const empId1 = generateEmployeeId();
      const empId2 = generateEmployeeId();
      const csvData = [
        'employee_id,username,email,displayName,role',
        `${empId1},usr_${empId1},${empId1}@internal.test,CSV Worker 1,EMPLOYEE`,
        `${empId2},usr_${empId2},${empId2}@internal.test,CSV Worker 2,EMPLOYEE`
      ].join('\n');

      const res = await superAdminClient.post('/api/employees/bulk-import', {
        csv: csvData,
        defaultShiftId: 'shift-std'
      });

      assertStatus(res, 200);
      assert.strictEqual(res.data.inserted, 2);
      assert.strictEqual(res.data.failed, 0);

      // Verify default shift assignment exists in database
      const db = getDb();
      const u = db.prepare('SELECT id FROM users WHERE employee_id = ?').get(empId1);
      assert.ok(u);
      const sa = db.prepare('SELECT shift_id FROM shift_assignments WHERE user_id = ?').get(u.id);
      assert.ok(sa);
      assert.strictEqual(sa.shift_id, 'shift-std');
    });
  });

  // =========================================================================
  // 3. Department & Team Hierarchy
  // =========================================================================
  describe('3. Department & Team Hierarchy', () => {
    it('3.1: Creates department and prevents duplicate department code', async () => {
      const deptData = generateDepartmentData();
      const res = await superAdminClient.post('/api/departments', deptData);
      assertStatus(res, 200);
      assert.ok(res.data.department);
      testDeptId = res.data.department.id;

      // Duplicate code rejected with 409
      const dupRes = await superAdminClient.post('/api/departments', {
        name: 'Another Name',
        code: deptData.code
      });
      assert.ok([400, 409].includes(dupRes.status));
    });

    it('3.2: Creates team linked to parent department and rejects non-existent department', async () => {
      const teamData = generateTeamData(testDeptId);
      const res = await superAdminClient.post('/api/teams', teamData);
      assertStatus(res, 200);
      assert.ok(res.data.team);
      testTeamId = res.data.team.id;

      // Orphan team rejected with 404
      const orphanRes = await superAdminClient.post('/api/teams', {
        name: 'Ghost Team',
        departmentId: 'dept-does-not-exist'
      });
      assert.ok([400, 404].includes(orphanRes.status));
    });

    it('3.3: Prevents deletion of department that contains active child teams', async () => {
      const delRes = await superAdminClient.delete(`/api/departments/${testDeptId}`);
      assert.ok([400, 409].includes(delRes.status));

      // Clean up team first
      const delTeamRes = await superAdminClient.delete(`/api/teams/${testTeamId}`);
      assertStatus(delTeamRes, 200);

      // Now department deletion succeeds
      const delDeptRes = await superAdminClient.delete(`/api/departments/${testDeptId}`);
      assertStatus(delDeptRes, 200);
    });
  });

  // =========================================================================
  // 4. Shift Management & Rostering
  // =========================================================================
  describe('4. Shift Management & Rostering', () => {
    it('4.1: Validates shift time format and mathematical boundaries', async () => {
      // Invalid time format (e.g. 25:00)
      assert.throws(() => {
        shiftService.createShift({ name: 'Bad Shift', startTime: '25:00', endTime: '18:00' });
      }, (err) => err.statusCode === 400);

      // Zero targetHours
      assert.throws(() => {
        shiftService.createShift({ name: 'Zero Target', startTime: '09:00', endTime: '18:00', targetHours: 0 });
      }, (err) => err.statusCode === 400);

      // Negative graceMinutes
      assert.throws(() => {
        shiftService.createShift({ name: 'Neg Grace', startTime: '09:00', endTime: '18:00', graceMinutes: -5 });
      }, (err) => err.statusCode === 400);

      // Identical start and end time
      assert.throws(() => {
        shiftService.createShift({ name: 'Equal Times', startTime: '09:00', endTime: '09:00' });
      }, (err) => err.statusCode === 400);
    });

    it('4.2: Creates overnight shift and correctly resolves is_overnight flag', async () => {
      const shiftData = generateShiftData({
        startTime: '21:30',
        endTime: '05:30',
        isOvernight: true
      });

      const res = await superAdminClient.post('/api/shifts', shiftData);
      assertStatus(res, 200);
      assert.strictEqual(res.data.shift.isOvernight, true);
      testShiftId = res.data.shift.id;
    });

    it('4.3: Mid-session shift assignment updates roster without corrupting active clock-in', async () => {
      const db = getDb();
      const testUser = employeeService.createEmployee({
        employeeId: generateEmployeeId(),
        username: generateUsername(),
        email: generateEmail()
      });

      // Start active session
      const sessId = `sess_shift_${Date.now()}`;
      db.prepare(`
        INSERT INTO attendance_sessions (id, user_id, clock_in, status, source, created_at)
        VALUES (?, ?, datetime('now'), 'IN_PROGRESS', 'API', datetime('now'))
      `).run(sessId, testUser.id);

      // Assign new shift mid-session
      const assignRes = await superAdminClient.post('/api/shifts/assign', {
        userId: testUser.id,
        shiftId: testShiftId
      });
      assertStatus(assignRes, 200);

      // Active session remains unaffected and in progress
      const sess = db.prepare('SELECT status FROM attendance_sessions WHERE id = ?').get(sessId);
      assert.strictEqual(sess.status, 'IN_PROGRESS');

      // Resolved shift reflects new assignment
      const userShift = shiftService.getUserShift(testUser.id);
      assert.strictEqual(userShift.id, testShiftId);
    });
  });
});
