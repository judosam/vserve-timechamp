/**
 * VserveTimeChamp Employee Management Service
 * Pure Node.js (zero external dependencies)
 * Handles CRUD, validations, RBAC scoping, and bulk import.
 */

const { getDb, transaction } = require('../db/index');
const { hashPassword, sanitizeUser, normalizeRole, isUserAdmin, ROLES } = require('./authService');
const { scopeQuery } = require('../middleware/rbac');
const { logAuditEvent, AUDIT_ACTIONS } = require('./auditService');

/**
 * Lists employees with role-based scoping, pagination, and search filters.
 * @param {object} options
 * @returns {object}
 */
function listEmployees({
  currentUser,
  page = 1,
  limit = 50,
  departmentId,
  department,
  teamId,
  team,
  status,
  search
} = {}) {
  const db = getDb();
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.max(1, parseInt(limit, 10) || 50);
  const offset = (pageNum - 1) * limitNum;

  const conditions = [];
  const params = [];

  // 1. Role-based scoping
  if (currentUser) {
    const scope = scopeQuery(currentUser, 'employees', 'u');
    if (scope && scope.whereClause) {
      conditions.push(scope.whereClause);
      params.push(...scope.params);
    }
  }

  // 2. Department filter (ID or Name)
  if (departmentId) {
    conditions.push('(u.department_id = ?)');
    params.push(departmentId);
  } else if (department) {
    conditions.push('(u.department_id = ? OR d.name = ?)');
    params.push(department, department);
  }

  // 3. Team filter (ID or Name)
  if (teamId) {
    conditions.push('(u.team_id = ?)');
    params.push(teamId);
  } else if (team) {
    conditions.push('(u.team_id = ? OR t.name = ?)');
    params.push(team, team);
  }

  // 4. Status filter
  if (status) {
    const s = String(status).toUpperCase();
    if (s === 'ACTIVE' || s === '1') {
      conditions.push('u.is_active = 1');
    } else if (s === 'INACTIVE' || s === '0') {
      conditions.push('u.is_active = 0');
    }
  }

  // 5. Search query
  if (search && String(search).trim()) {
    const term = `%${String(search).trim()}%`;
    conditions.push('(u.username LIKE ? OR u.display_name LIKE ? OR u.employee_id LIKE ? OR u.email LIKE ?)');
    params.push(term, term, term, term);
  }

  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const totalRow = db.prepare(`
    SELECT COUNT(*) as count
    FROM users u
    LEFT JOIN departments d ON u.department_id = d.id
    LEFT JOIN teams t ON u.team_id = t.id
    ${whereSql}
  `).get(...params);

  const total = totalRow ? totalRow.count : 0;

  const rows = db.prepare(`
    SELECT u.*, d.name as dept_name, t.name as team_name
    FROM users u
    LEFT JOIN departments d ON u.department_id = d.id
    LEFT JOIN teams t ON u.team_id = t.id
    ${whereSql}
    ORDER BY u.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limitNum, offset);

  return {
    employees: rows.map(r => sanitizeUser({
      ...r,
      department: r.dept_name || 'General',
      team: r.team_name || 'General Team'
    })),
    total,
    page: pageNum,
    limit: limitNum
  };
}

/**
 * Retrieves a single employee by ID, employeeId, or username.
 * @param {string} id
 * @returns {object|null}
 */
function getEmployeeById(id) {
  if (!id) return null;
  const db = getDb();
  const row = db.prepare(`
    SELECT u.*, d.name as dept_name, t.name as team_name
    FROM users u
    LEFT JOIN departments d ON u.department_id = d.id
    LEFT JOIN teams t ON u.team_id = t.id
    WHERE u.id = ? OR u.employee_id = ? OR u.username = ?
  `).get(id, id, id);

  if (!row) return null;
  const leaveBalances = db.prepare(`
    SELECT * FROM leave_balances WHERE user_id = ? AND year = ?
  `).all(row.id, new Date().getFullYear());

  return {
    ...sanitizeUser({
      ...row,
      department: row.dept_name || 'General',
      team: row.team_name || 'General Team'
    }),
    leaveBalances: leaveBalances.map(lb => ({
      id: lb.id,
      leaveType: lb.leave_type,
      totalAllocated: lb.total_allocated,
      used: lb.used,
      remaining: lb.remaining
    }))
  };
}

/**
 * Creates a new employee with strict uniqueness validations.
 * @param {object} data
 * @param {object} [req]
 * @returns {object}
 */
function createEmployee(data = {}, req = null) {
  const db = getDb();
  const employeeId = (data.employeeId || data.employee_id || '').trim();
  const username = (data.username || '').trim();
  const email = (data.email || '').trim().toLowerCase();
  const displayName = (data.displayName || data.display_name || username).trim();
  const role = data.role ? normalizeRole(data.role) : ROLES.EMPLOYEE;
  const departmentId = data.departmentId || data.department_id || null;
  const teamId = data.teamId || data.team_id || null;
  const designation = data.designation || displayName || null;
  const phone = data.phone || null;
  const machine = data.machine || null;
  const targetDailyHours = parseFloat(data.targetDailyHours || data.target_daily_hours || 8.0);
  const password = data.password ? String(data.password).trim() : 'Employee@2026';
  const status = (data.status || 'ACTIVE').toUpperCase();
  const isActive = (status === 'ACTIVE' || status === '1') ? 1 : 0;

  // 1. Mandatory fields
  if (!username) {
    const err = new Error('Username is required');
    err.statusCode = 400;
    throw err;
  }
  if (!employeeId) {
    const err = new Error('Employee ID is required');
    err.statusCode = 400;
    throw err;
  }
  if (!email) {
    const err = new Error('Email is required');
    err.statusCode = 400;
    throw err;
  }
  if (!email.includes('@') || !email.includes('.')) {
    const err = new Error('Invalid email address format');
    err.statusCode = 400;
    throw err;
  }

  // 2. Duplicate validation
  const existingId = db.prepare('SELECT id FROM users WHERE employee_id = ?').get(employeeId);
  if (existingId) {
    const err = new Error(`Employee ID "${employeeId}" is already in use`);
    err.statusCode = 409;
    throw err;
  }

  const existingEmail = db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)').get(email);
  if (existingEmail) {
    const err = new Error(`Email address "${email}" is already in use`);
    err.statusCode = 409;
    throw err;
  }

  const existingUsername = db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)').get(username);
  if (existingUsername) {
    const err = new Error(`Username "${username}" is already in use`);
    err.statusCode = 409;
    throw err;
  }

  // 3. Password hashing
  const { salt, hash } = hashPassword(password);
  const id = `usr-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const now = new Date().toISOString();
  const joinDate = data.joinDate || data.join_date || now.slice(0, 10);

  // 4. Insert user
  db.prepare(`
    INSERT INTO users (
      id, employee_id, username, password_hash, salt, display_name, role,
      department_id, team_id, designation, status, join_date, email, phone, is_active,
      target_daily_hours, idle_threshold_seconds, machine, enable_app_tracking, enable_browser_tracking,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 600, ?, 1, 1, ?, ?)
  `).run(
    id, employeeId, username, hash, salt, displayName, role,
    departmentId, teamId, designation, status, joinDate, email, phone, isActive,
    targetDailyHours, machine, now, now
  );

  // 5. Initialize standard leave balances for new employee
  const currentYear = new Date().getFullYear();
  db.prepare(`
    INSERT OR IGNORE INTO leave_balances (id, user_id, leave_type, year, total_allocated, used, remaining, updated_at)
    VALUES (?, ?, 'ANNUAL', ?, 18.0, 0, 18.0, ?)
  `).run(`lb-${id}-annual-${currentYear}`, id, currentYear, now);

  db.prepare(`
    INSERT OR IGNORE INTO leave_balances (id, user_id, leave_type, year, total_allocated, used, remaining, updated_at)
    VALUES (?, ?, 'SICK', ?, 12.0, 0, 12.0, ?)
  `).run(`lb-${id}-sick-${currentYear}`, id, currentYear, now);

  db.prepare(`
    INSERT OR IGNORE INTO leave_balances (id, user_id, leave_type, year, total_allocated, used, remaining, updated_at)
    VALUES (?, ?, 'CASUAL', ?, 6.0, 0, 6.0, ?)
  `).run(`lb-${id}-casual-${currentYear}`, id, currentYear, now);

  // 6. Assign default shift if provided or standard
  const shiftId = data.shiftId || data.shift_id || 'shift-std';
  db.prepare(`
    INSERT OR IGNORE INTO shift_assignments (id, user_id, shift_id, start_date, effective_from, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(`sa-${id}`, id, shiftId, joinDate, joinDate, now);

  // 7. Audit log
  logAuditEvent({
    req,
    action: AUDIT_ACTIONS.USER_CREATE || 'USER_CREATE',
    targetEntity: 'users',
    targetId: id,
    details: { employeeId, username, email, role }
  });

  return getEmployeeById(id);
}

/**
 * Updates an employee's details with uniqueness check.
 * @param {string} id
 * @param {object} data
 * @param {object} [req]
 * @returns {object}
 */
function updateEmployee(id, data = {}, req = null) {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ? OR employee_id = ?').get(id, id);
  if (!user) {
    const err = new Error(`Employee "${id}" not found`);
    err.statusCode = 404;
    throw err;
  }

  // Uniqueness check for email
  const newEmail = (data.email || '').trim().toLowerCase();
  if (newEmail && newEmail !== (user.email || '').toLowerCase()) {
    const emailConflict = db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?) AND id != ?').get(newEmail, user.id);
    if (emailConflict) {
      const err = new Error(`Email address "${newEmail}" is already in use`);
      err.statusCode = 409;
      throw err;
    }
  }

  // Uniqueness check for employeeId
  const newEmpId = (data.employeeId || data.employee_id || '').trim();
  if (newEmpId && newEmpId !== user.employee_id) {
    const idConflict = db.prepare('SELECT id FROM users WHERE employee_id = ? AND id != ?').get(newEmpId, user.id);
    if (idConflict) {
      const err = new Error(`Employee ID "${newEmpId}" is already in use`);
      err.statusCode = 409;
      throw err;
    }
  }

  // Uniqueness check for username
  const newUsername = (data.username || '').trim();
  if (newUsername && newUsername.toLowerCase() !== user.username.toLowerCase()) {
    const userConflict = db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?) AND id != ?').get(newUsername, user.id);
    if (userConflict) {
      const err = new Error(`Username "${newUsername}" is already in use`);
      err.statusCode = 409;
      throw err;
    }
  }

  const updates = [];
  const params = [];

  if (data.displayName !== undefined || data.display_name !== undefined) {
    updates.push('display_name = ?');
    params.push((data.displayName || data.display_name).trim());
  }
  if (newEmail) {
    updates.push('email = ?');
    params.push(newEmail);
  }
  if (newEmpId) {
    updates.push('employee_id = ?');
    params.push(newEmpId);
  }
  if (newUsername) {
    updates.push('username = ?');
    params.push(newUsername);
  }
  if (data.departmentId !== undefined || data.department_id !== undefined) {
    updates.push('department_id = ?');
    params.push(data.departmentId || data.department_id || null);
  }
  if (data.teamId !== undefined || data.team_id !== undefined) {
    updates.push('team_id = ?');
    params.push(data.teamId || data.team_id || null);
  }
  if (data.designation !== undefined) {
    updates.push('designation = ?');
    params.push(data.designation);
  }
  if (data.role !== undefined) {
    updates.push('role = ?');
    params.push(normalizeRole(data.role));
  }
  if (data.targetDailyHours !== undefined || data.target_daily_hours !== undefined) {
    updates.push('target_daily_hours = ?');
    params.push(parseFloat(data.targetDailyHours || data.target_daily_hours));
  }
  if (data.machine !== undefined) {
    updates.push('machine = ?');
    params.push(data.machine);
  }
  if (data.phone !== undefined) {
    updates.push('phone = ?');
    params.push(data.phone);
  }
  if (data.status !== undefined) {
    const s = String(data.status).toUpperCase();
    const isActive = (s === 'ACTIVE' || s === '1') ? 1 : 0;
    updates.push('status = ?', 'is_active = ?');
    params.push(s, isActive);
  }
  if (data.password && String(data.password).trim()) {
    const { salt, hash } = hashPassword(String(data.password).trim());
    updates.push('password_hash = ?', 'salt = ?');
    params.push(hash, salt);
  }

  updates.push('updated_at = ?');
  params.push(new Date().toISOString());

  params.push(user.id);
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  logAuditEvent({
    req,
    action: AUDIT_ACTIONS.USER_UPDATE || 'USER_UPDATE',
    targetEntity: 'users',
    targetId: user.id,
    details: { changes: Object.keys(data) }
  });

  return getEmployeeById(user.id);
}

/**
 * Soft deactivates an employee and cleanly closes any active session if requested.
 * @param {string} id
 * @param {boolean} autoClockOut
 * @param {object} [req]
 * @returns {object}
 */
function deactivateEmployee(id, autoClockOut = false, req = null) {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ? OR employee_id = ?').get(id, id);
  if (!user) {
    const err = new Error(`Employee "${id}" not found`);
    err.statusCode = 404;
    throw err;
  }

  const now = new Date().toISOString();
  db.prepare("UPDATE users SET is_active = 0, status = 'INACTIVE', updated_at = ? WHERE id = ?").run(now, user.id);

  if (autoClockOut === true || autoClockOut === 'true') {
    const activeSession = db.prepare("SELECT * FROM attendance_sessions WHERE user_id = ? AND status = 'IN_PROGRESS'").get(user.id);
    if (activeSession) {
      const inMs = new Date(activeSession.clock_in).getTime();
      const outMs = new Date(now).getTime();
      const grossSec = Math.max(0, Math.floor((outMs - inMs) / 1000));
      db.prepare(`
        UPDATE attendance_sessions
        SET clock_out = ?, status = 'AUTO_CLOSED', gross_duration = ?, net_duration = ?
        WHERE id = ?
      `).run(now, grossSec, grossSec, activeSession.id);
    }
  }

  logAuditEvent({
    req,
    action: AUDIT_ACTIONS.USER_DELETE || 'USER_DELETE',
    targetEntity: 'users',
    targetId: user.id,
    details: { autoClockOut: Boolean(autoClockOut) }
  });

  return { success: true, deleted: user.id, employeeId: user.employee_id };
}

/**
 * Helper to parse CSV string into array of employee objects.
 * @param {string} text
 * @returns {Array<object>}
 */
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/^["']|["']$/g, ''));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(v => v.trim().replace(/^["']|["']$/g, ''));
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = values[idx] || '';
    });
    rows.push(obj);
  }
  return rows;
}

/**
 * Performs bulk import of employees supporting JSON and CSV formats.
 * @param {object|string} payload
 * @param {object} [req]
 * @returns {object}
 */
function bulkImportEmployees(payload, req = null) {
  let employees = [];
  let defaultShiftId = null;
  let dryRun = false;

  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if (!trimmed) {
      const err = new Error('Payload cannot be empty');
      err.statusCode = 400;
      throw err;
    }
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          employees = parsed;
        } else if (parsed && typeof parsed === 'object') {
          employees = parsed.employees || [];
          defaultShiftId = parsed.defaultShiftId || null;
          dryRun = Boolean(parsed.dryRun);
        }
      } catch (e) {
        const err = new Error('Invalid JSON payload');
        err.statusCode = 400;
        throw err;
      }
    } else {
      employees = parseCSV(trimmed);
    }
  } else if (payload && typeof payload === 'object') {
    if (Array.isArray(payload)) {
      employees = payload;
    } else {
      defaultShiftId = payload.defaultShiftId || null;
      dryRun = Boolean(payload.dryRun);
      if (Array.isArray(payload.employees)) {
        employees = payload.employees;
      } else if (typeof payload.csv === 'string') {
        employees = parseCSV(payload.csv);
      } else {
        const err = new Error('Payload must contain "employees" array or "csv" string');
        err.statusCode = 400;
        throw err;
      }
    }
  } else {
    const err = new Error('Malformed payload');
    err.statusCode = 400;
    throw err;
  }

  if (!Array.isArray(employees) || employees.length === 0) {
    const err = new Error('Payload must contain at least one employee record');
    err.statusCode = 400;
    throw err;
  }

  const db = getDb();
  const errors = [];
  const validRecords = [];
  const seenEmpIds = new Set();
  const seenEmails = new Set();
  const seenUsernames = new Set();

  employees.forEach((emp, index) => {
    const rowNum = index + 1;
    if (!emp || typeof emp !== 'object') {
      errors.push({ row: rowNum, error: 'Malformed row data' });
      return;
    }

    const empId = String(emp.employeeId || emp.employee_id || '').trim();
    const email = String(emp.email || '').trim().toLowerCase();
    const username = String(emp.username || empId || email.split('@')[0] || '').trim();

    if (!empId) {
      errors.push({ row: rowNum, field: 'employeeId', error: 'Missing employeeId' });
      return;
    }
    if (!email) {
      errors.push({ row: rowNum, employeeId: empId, field: 'email', error: 'Missing email' });
      return;
    }
    if (!email.includes('@') || !email.includes('.')) {
      errors.push({ row: rowNum, employeeId: empId, email, field: 'email', error: 'Invalid email format' });
      return;
    }

    // Duplicate check within batch
    if (seenEmpIds.has(empId)) {
      errors.push({ row: rowNum, employeeId: empId, field: 'employeeId', error: 'Duplicate employeeId within import batch' });
      return;
    }
    if (seenEmails.has(email)) {
      errors.push({ row: rowNum, employeeId: empId, email, field: 'email', error: 'Duplicate email within import batch' });
      return;
    }
    if (username && seenUsernames.has(username.toLowerCase())) {
      errors.push({ row: rowNum, employeeId: empId, username, field: 'username', error: 'Duplicate username within import batch' });
      return;
    }

    seenEmpIds.add(empId);
    seenEmails.add(email);
    if (username) seenUsernames.add(username.toLowerCase());

    // Duplicate check against Database
    const dbEmp = db.prepare('SELECT id FROM users WHERE employee_id = ?').get(empId);
    if (dbEmp) {
      errors.push({ row: rowNum, employeeId: empId, field: 'employeeId', error: 'employeeId already exists in database' });
      return;
    }

    const dbEmail = db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)').get(email);
    if (dbEmail) {
      errors.push({ row: rowNum, employeeId: empId, email, field: 'email', error: 'email already exists in database' });
      return;
    }

    if (username) {
      const dbUser = db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)').get(username);
      if (dbUser) {
        errors.push({ row: rowNum, employeeId: empId, username, field: 'username', error: 'username already exists in database' });
        return;
      }
    }

    validRecords.push({
      ...emp,
      employeeId: empId,
      email,
      username
    });
  });

  if (dryRun) {
    return {
      success: true,
      dryRun: true,
      total: employees.length,
      inserted: 0,
      failed: errors.length,
      errors
    };
  }

  // Live atomic transaction
  transaction(() => {
    for (const record of validRecords) {
      const created = createEmployee(record, req);
      const targetShift = record.shiftId || record.shift_id || defaultShiftId;
      if (targetShift && created && created.id) {
        const shiftExists = db.prepare('SELECT id FROM shifts WHERE id = ?').get(targetShift);
        if (!shiftExists) {
          const nowIso = new Date().toISOString();
          db.prepare(`
            INSERT OR IGNORE INTO shifts (id, name, code, start_time, end_time, is_overnight, grace_minutes, break_allowance_minutes, target_hours, created_at, updated_at)
            VALUES (?, ?, ?, '09:00', '18:00', 0, 15, 60, 8.0, ?, ?)
          `).run(targetShift, targetShift, 'STD', nowIso, nowIso);
        }
        db.prepare(`
          INSERT OR REPLACE INTO shift_assignments (id, user_id, shift_id, start_date, effective_from, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          `sa-${created.id}`,
          created.id,
          targetShift,
          new Date().toISOString().slice(0, 10),
          new Date().toISOString().slice(0, 10),
          new Date().toISOString()
        );
      }
    }
  });

  logAuditEvent({
    req,
    action: AUDIT_ACTIONS.USER_BULK_IMPORT || 'USER_BULK_IMPORT',
    targetEntity: 'users',
    details: { total: employees.length, inserted: validRecords.length, failed: errors.length }
  });

  return {
    success: true,
    dryRun: false,
    total: employees.length,
    inserted: validRecords.length,
    failed: errors.length,
    errors
  };
}

module.exports = {
  listEmployees,
  getEmployeeById,
  createEmployee,
  updateEmployee,
  deactivateEmployee,
  bulkImportEmployees
};
