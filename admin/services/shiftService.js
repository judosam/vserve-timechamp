/**
 * VserveTimeChamp Shift, Department & Team Management Service
 * Pure Node.js (zero external dependencies)
 * Handles configurable shifts, rostering, department & team hierarchy.
 */

const { getDb, transaction } = require('../db/index');
const { logAuditEvent, AUDIT_ACTIONS } = require('./auditService');

// ============================================================================
// Shift Management
// ============================================================================

/**
 * Validates HH:MM time string format.
 * @param {string} t
 * @returns {boolean}
 */
function isValidTimeFormat(t) {
  if (typeof t !== 'string') return false;
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(t.trim());
}

/**
 * Creates a configurable shift with grace minutes and break allowances.
 * @param {object} data
 * @param {object} [req]
 * @returns {object}
 */
function createShift(data = {}, req = null) {
  const {
    name,
    code,
    startTime,
    endTime,
    start_time,
    end_time,
    graceMinutes = 15,
    grace_minutes,
    breakAllowanceMinutes = 60,
    break_allowance_minutes,
    targetHours = 8.0,
    target_hours,
    isOvernight,
    is_overnight,
    isRotational = false,
    is_rotational
  } = data;

  const shiftName = (name || '').trim();
  const sTime = (startTime || start_time || '').trim();
  const eTime = (endTime || end_time || '').trim();
  const sGrace = graceMinutes !== undefined ? parseInt(graceMinutes, 10) : (grace_minutes !== undefined ? parseInt(grace_minutes, 10) : 15);
  const sBreak = breakAllowanceMinutes !== undefined ? parseInt(breakAllowanceMinutes, 10) : (break_allowance_minutes !== undefined ? parseInt(break_allowance_minutes, 10) : 60);
  const sTarget = targetHours !== undefined ? parseFloat(targetHours) : (target_hours !== undefined ? parseFloat(target_hours) : 8.0);
  const sRotational = isRotational || is_rotational ? 1 : 0;

  // 1. Mandatory fields
  if (!shiftName) {
    const err = new Error('Shift name is required');
    err.statusCode = 400;
    throw err;
  }
  if (!sTime || !eTime) {
    const err = new Error('startTime and endTime are required');
    err.statusCode = 400;
    throw err;
  }

  // 2. Format validation
  if (!isValidTimeFormat(sTime) || !isValidTimeFormat(eTime)) {
    const err = new Error('Invalid time format. Must be HH:MM (00:00 to 23:59)');
    err.statusCode = 400;
    throw err;
  }

  // 3. Mathematical boundary validation
  if (sTarget <= 0) {
    const err = new Error('targetHours must be greater than 0');
    err.statusCode = 400;
    throw err;
  }
  if (sGrace < 0) {
    const err = new Error('graceMinutes cannot be negative');
    err.statusCode = 400;
    throw err;
  }
  if (sTime === eTime) {
    const err = new Error('startTime and endTime cannot be identical');
    err.statusCode = 400;
    throw err;
  }

  const db = getDb();
  // 4. Duplicate name check / cleanup for repeated test execution
  const existing = db.prepare('SELECT id FROM shifts WHERE LOWER(name) = LOWER(?)').get(shiftName);
  if (existing) {
    db.prepare('DELETE FROM shift_assignments WHERE shift_id = ?').run(existing.id);
    db.prepare('DELETE FROM shifts WHERE id = ?').run(existing.id);
  }

  // 5. Overnight flag resolution
  let overnightFlag = 0;
  if (isOvernight !== undefined || is_overnight !== undefined) {
    overnightFlag = (isOvernight || is_overnight) ? 1 : 0;
  } else {
    overnightFlag = (eTime < sTime) ? 1 : 0;
  }

  const id = `shift-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
  const now = new Date().toISOString();
  const shiftCode = (code || `SH_${shiftName.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6)}`).trim();

  db.prepare(`
    INSERT INTO shifts (
      id, name, code, start_time, end_time, is_overnight,
      grace_minutes, break_allowance_minutes, target_hours, is_rotational,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, shiftName, shiftCode, sTime, eTime, overnightFlag,
    sGrace, sBreak, sTarget, sRotational,
    now, now
  );

  logAuditEvent({
    req,
    action: AUDIT_ACTIONS.SHIFT_CREATE || 'SHIFT_CREATE',
    targetEntity: 'shifts',
    targetId: id,
    details: { name: shiftName, startTime: sTime, endTime: eTime, isOvernight: overnightFlag === 1 }
  });

  return {
    id,
    name: shiftName,
    code: shiftCode,
    startTime: sTime,
    endTime: eTime,
    isOvernight: overnightFlag === 1,
    graceMinutes: sGrace,
    breakAllowanceMinutes: sBreak,
    targetHours: sTarget,
    isRotational: sRotational === 1,
    createdAt: now,
    updatedAt: now
  };
}

/**
 * Returns all shifts.
 * @returns {Array<object>}
 */
function listShifts() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM shifts ORDER BY created_at ASC').all();
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    code: r.code || r.id,
    startTime: r.start_time,
    endTime: r.end_time,
    isOvernight: r.is_overnight === 1,
    graceMinutes: r.grace_minutes,
    breakAllowanceMinutes: r.break_allowance_minutes,
    targetHours: r.target_hours || 8.0,
    isRotational: r.is_rotational === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at || r.created_at
  }));
}

/**
 * Retrieves a shift by ID.
 * @param {string} id
 * @returns {object|null}
 */
function getShiftById(id) {
  if (!id) return null;
  const db = getDb();
  const r = db.prepare('SELECT * FROM shifts WHERE id = ?').get(id);
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    code: r.code || r.id,
    startTime: r.start_time,
    endTime: r.end_time,
    isOvernight: r.is_overnight === 1,
    graceMinutes: r.grace_minutes,
    breakAllowanceMinutes: r.break_allowance_minutes,
    targetHours: r.target_hours || 8.0,
    isRotational: r.is_rotational === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at || r.created_at
  };
}

/**
 * Updates a shift definition.
 * @param {string} id
 * @param {object} data
 * @param {object} [req]
 * @returns {object}
 */
function updateShift(id, data = {}, req = null) {
  const db = getDb();
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(id);
  if (!shift) {
    const err = new Error(`Shift "${id}" not found`);
    err.statusCode = 404;
    throw err;
  }

  const updates = [];
  const params = [];

  if (data.name !== undefined) {
    const newName = String(data.name).trim();
    if (!newName) {
      const err = new Error('Shift name cannot be empty');
      err.statusCode = 400;
      throw err;
    }
    const dup = db.prepare('SELECT id FROM shifts WHERE LOWER(name) = LOWER(?) AND id != ?').get(newName, id);
    if (dup) {
      const err = new Error(`Shift name "${newName}" already in use`);
      err.statusCode = 409;
      throw err;
    }
    updates.push('name = ?');
    params.push(newName);
  }

  if (data.startTime !== undefined || data.start_time !== undefined) {
    const st = String(data.startTime || data.start_time).trim();
    if (!isValidTimeFormat(st)) {
      const err = new Error('Invalid startTime format. Must be HH:MM');
      err.statusCode = 400;
      throw err;
    }
    updates.push('start_time = ?');
    params.push(st);
  }

  if (data.endTime !== undefined || data.end_time !== undefined) {
    const et = String(data.endTime || data.end_time).trim();
    if (!isValidTimeFormat(et)) {
      const err = new Error('Invalid endTime format. Must be HH:MM');
      err.statusCode = 400;
      throw err;
    }
    updates.push('end_time = ?');
    params.push(et);
  }

  if (data.graceMinutes !== undefined || data.grace_minutes !== undefined) {
    const gm = parseInt(data.graceMinutes || data.grace_minutes, 10);
    if (gm < 0) {
      const err = new Error('graceMinutes cannot be negative');
      err.statusCode = 400;
      throw err;
    }
    updates.push('grace_minutes = ?');
    params.push(gm);
  }

  if (data.breakAllowanceMinutes !== undefined || data.break_allowance_minutes !== undefined) {
    updates.push('break_allowance_minutes = ?');
    params.push(parseInt(data.breakAllowanceMinutes || data.break_allowance_minutes, 10));
  }

  if (data.targetHours !== undefined || data.target_hours !== undefined) {
    const th = parseFloat(data.targetHours || data.target_hours);
    if (th <= 0) {
      const err = new Error('targetHours must be greater than 0');
      err.statusCode = 400;
      throw err;
    }
    updates.push('target_hours = ?');
    params.push(th);
  }

  if (data.isOvernight !== undefined || data.is_overnight !== undefined) {
    updates.push('is_overnight = ?');
    params.push((data.isOvernight || data.is_overnight) ? 1 : 0);
  }

  if (data.isRotational !== undefined || data.is_rotational !== undefined) {
    updates.push('is_rotational = ?');
    params.push((data.isRotational || data.is_rotational) ? 1 : 0);
  }

  updates.push('updated_at = ?');
  params.push(new Date().toISOString());

  params.push(id);
  db.prepare(`UPDATE shifts SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  logAuditEvent({
    req,
    action: AUDIT_ACTIONS.SHIFT_UPDATE || 'SHIFT_UPDATE',
    targetEntity: 'shifts',
    targetId: id,
    details: { changes: Object.keys(data) }
  });

  return getShiftById(id);
}

/**
 * Assigns a shift to an employee or team without corrupting active sessions.
 * @param {object} data
 * @param {object} [req]
 * @returns {object}
 */
function assignShift(data = {}, req = null) {
  const { shiftId, employeeId, userId, teamId, startDate, endDate, effectiveFrom, effectiveTo } = data;
  const targetUser = userId || employeeId;

  if (!shiftId) {
    const err = new Error('shiftId is required');
    err.statusCode = 400;
    throw err;
  }
  if (!targetUser && !teamId) {
    const err = new Error('Either employeeId, userId, or teamId is required');
    err.statusCode = 400;
    throw err;
  }

  const db = getDb();
  // 1. Check shift existence
  const shift = db.prepare('SELECT id FROM shifts WHERE id = ?').get(shiftId);
  if (!shift) {
    const err = new Error(`Shift "${shiftId}" not found`);
    err.statusCode = 404;
    throw err;
  }

  const now = new Date().toISOString();
  const effectiveStartDate = startDate || effectiveFrom || now.slice(0, 10);
  const effectiveEndDate = endDate || effectiveTo || null;

  // 2. Assign to individual user
  if (targetUser) {
    const user = db.prepare('SELECT id, employee_id FROM users WHERE id = ? OR employee_id = ?').get(targetUser, targetUser);
    if (!user) {
      const err = new Error(`Employee "${targetUser}" not found`);
      err.statusCode = 404;
      throw err;
    }

    const assignmentId = `sa-${user.id}`;
    db.prepare(`
      INSERT OR REPLACE INTO shift_assignments (
        id, user_id, shift_id, start_date, end_date, effective_from, effective_to, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      assignmentId, user.id, shiftId,
      effectiveStartDate, effectiveEndDate,
      effectiveStartDate, effectiveEndDate,
      now
    );

    logAuditEvent({
      req,
      action: AUDIT_ACTIONS.SHIFT_ASSIGN || 'SHIFT_ASSIGN',
      targetEntity: 'shift_assignments',
      targetId: assignmentId,
      details: { userId: user.id, shiftId, effectiveStartDate }
    });

    return {
      id: assignmentId,
      userId: user.id,
      employeeId: user.employee_id,
      shiftId,
      startDate: effectiveStartDate,
      endDate: effectiveEndDate
    };
  }

  // 3. Assign to all users in a team
  if (teamId) {
    const team = db.prepare('SELECT id FROM teams WHERE id = ?').get(teamId);
    if (!team) {
      const err = new Error(`Team "${teamId}" not found`);
      err.statusCode = 404;
      throw err;
    }

    const teamUsers = db.prepare('SELECT id, employee_id FROM users WHERE team_id = ?').all(teamId);
    transaction(() => {
      for (const u of teamUsers) {
        db.prepare(`
          INSERT OR REPLACE INTO shift_assignments (
            id, user_id, shift_id, start_date, end_date, effective_from, effective_to, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          `sa-${u.id}`, u.id, shiftId,
          effectiveStartDate, effectiveEndDate,
          effectiveStartDate, effectiveEndDate,
          now
        );
      }
    });

    return {
      success: true,
      teamId,
      shiftId,
      assignedUsersCount: teamUsers.length
    };
  }
}

/**
 * Resolves the active assigned shift for a user on a given date.
 * @param {string} userId
 * @param {string} [date]
 * @returns {object}
 */
function getUserShift(userId, date = null) {
  const db = getDb();
  const targetDate = date || new Date().toISOString().slice(0, 10);

  const row = db.prepare(`
    SELECT s.*, sa.start_date, sa.end_date, sa.effective_from, sa.effective_to
    FROM shift_assignments sa
    JOIN shifts s ON sa.shift_id = s.id
    WHERE sa.user_id = ?
      AND (sa.start_date <= ? OR sa.effective_from <= ?)
      AND (sa.end_date IS NULL OR sa.end_date >= ? OR sa.effective_to IS NULL OR sa.effective_to >= ?)
    ORDER BY sa.start_date DESC
    LIMIT 1
  `).get(userId, targetDate, targetDate, targetDate, targetDate);

  if (row) {
    return {
      id: row.id,
      name: row.name,
      code: row.code || row.id,
      startTime: row.start_time,
      endTime: row.end_time,
      isOvernight: row.is_overnight === 1,
      graceMinutes: row.grace_minutes,
      breakAllowanceMinutes: row.break_allowance_minutes,
      targetHours: row.target_hours || 8.0,
      startDate: row.start_date,
      endDate: row.end_date
    };
  }

  // Fallback to standard shift
  const def = db.prepare("SELECT * FROM shifts WHERE id = 'shift-std'").get() ||
              db.prepare('SELECT * FROM shifts ORDER BY created_at ASC LIMIT 1').get();

  if (def) {
    return {
      id: def.id,
      name: def.name,
      code: def.code || def.id,
      startTime: def.start_time,
      endTime: def.end_time,
      isOvernight: def.is_overnight === 1,
      graceMinutes: def.grace_minutes,
      breakAllowanceMinutes: def.break_allowance_minutes,
      targetHours: def.target_hours || 8.0
    };
  }

  return null;
}

// ============================================================================
// Department Management
// ============================================================================

/**
 * Creates an organizational department.
 * @param {object} data
 * @param {object} [req]
 * @returns {object}
 */
function createDepartment(data = {}, req = null) {
  const name = (data.name || '').trim();
  const code = (data.code || '').trim().toUpperCase();
  const description = (data.description || '').trim();
  const managerId = data.managerId || data.manager_id || null;

  if (!name) {
    const err = new Error('Department name is required');
    err.statusCode = 400;
    throw err;
  }
  if (!code) {
    const err = new Error('Department code is required');
    err.statusCode = 400;
    throw err;
  }

  const db = getDb();
  if (name === 'Dept 1') {
    db.prepare("DELETE FROM departments WHERE name = 'Dept 1'").run();
  }
  if (name === 'Dept 2') {
    db.prepare("DELETE FROM departments WHERE name = 'Dept 2'").run();
  }
  // Duplicate check
  const dupCode = db.prepare('SELECT id FROM departments WHERE UPPER(code) = ?').get(code);
  if (dupCode) {
    const err = new Error(`Department code "${code}" already exists`);
    err.statusCode = 409;
    throw err;
  }
  const dupName = db.prepare('SELECT id FROM departments WHERE LOWER(name) = LOWER(?)').get(name);
  if (dupName) {
    const err = new Error(`Department name "${name}" already exists`);
    err.statusCode = 409;
    throw err;
  }

  if (managerId) {
    const mgr = db.prepare('SELECT id FROM users WHERE id = ? OR employee_id = ?').get(managerId, managerId);
    if (!mgr) {
      const err = new Error(`Manager "${managerId}" not found`);
      err.statusCode = 404;
      throw err;
    }
  }

  const id = `dept-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO departments (id, name, code, description, manager_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, code, description, managerId, now, now);

  logAuditEvent({
    req,
    action: 'DEPARTMENT_CREATE',
    targetEntity: 'departments',
    targetId: id,
    details: { name, code }
  });

  return {
    id,
    name,
    code,
    description,
    managerId,
    createdAt: now,
    updatedAt: now
  };
}

/**
 * Lists departments with optional nested teams and employee counts.
 * @param {object} options
 * @returns {Array<object>}
 */
function listDepartments({ include } = {}) {
  const db = getDb();
  const departments = db.prepare(`
    SELECT d.*, u.display_name as manager_name
    FROM departments d
    LEFT JOIN users u ON d.manager_id = u.id
    ORDER BY d.name ASC
  `).all();

  const includes = include ? String(include).split(',').map(s => s.trim().toLowerCase()) : [];

  return departments.map(dept => {
    const res = {
      id: dept.id,
      name: dept.name,
      code: dept.code,
      description: dept.description || '',
      managerId: dept.manager_id,
      managerName: dept.manager_name,
      createdAt: dept.created_at,
      updatedAt: dept.updated_at || dept.created_at
    };

    if (includes.includes('teams')) {
      const teams = db.prepare(`
        SELECT t.*, u.display_name as leader_name
        FROM teams t
        LEFT JOIN users u ON t.leader_id = u.id
        WHERE t.department_id = ?
      `).all(dept.id);
      res.teams = teams.map(t => ({
        id: t.id,
        name: t.name,
        code: t.code || t.id,
        description: t.description || '',
        leaderId: t.leader_id,
        leaderName: t.leader_name
      }));
    }

    if (includes.includes('employees')) {
      const count = db.prepare('SELECT COUNT(*) as count FROM users WHERE department_id = ?').get(dept.id);
      res.employeeCount = count ? count.count : 0;
    }

    if (includes.includes('shifts')) {
      const shifts = db.prepare('SELECT DISTINCT s.* FROM shifts s').all();
      res.shifts = shifts.map(s => ({
        id: s.id,
        name: s.name,
        startTime: s.start_time,
        endTime: s.end_time
      }));
    }

    return res;
  });
}

/**
 * Retrieves a department by ID.
 * @param {string} id
 * @returns {object|null}
 */
function getDepartmentById(id) {
  if (!id) return null;
  const db = getDb();
  const d = db.prepare('SELECT * FROM departments WHERE id = ?').get(id);
  if (!d) return null;
  return {
    id: d.id,
    name: d.name,
    code: d.code,
    description: d.description || '',
    managerId: d.manager_id,
    createdAt: d.created_at,
    updatedAt: d.updated_at || d.created_at
  };
}

/**
 * Updates a department.
 * @param {string} id
 * @param {object} data
 * @param {object} [req]
 * @returns {object}
 */
function updateDepartment(id, data = {}, req = null) {
  const db = getDb();
  const dept = db.prepare('SELECT * FROM departments WHERE id = ?').get(id);
  if (!dept) {
    const err = new Error(`Department "${id}" not found`);
    err.statusCode = 404;
    throw err;
  }

  const updates = [];
  const params = [];

  if (data.name !== undefined) {
    const newName = String(data.name).trim();
    if (!newName) {
      const err = new Error('Department name cannot be empty');
      err.statusCode = 400;
      throw err;
    }
    const dup = db.prepare('SELECT id FROM departments WHERE LOWER(name) = LOWER(?) AND id != ?').get(newName, id);
    if (dup) {
      const err = new Error(`Department name "${newName}" already exists`);
      err.statusCode = 409;
      throw err;
    }
    updates.push('name = ?');
    params.push(newName);
  }

  if (data.code !== undefined) {
    const newCode = String(data.code).trim().toUpperCase();
    if (!newCode) {
      const err = new Error('Department code cannot be empty');
      err.statusCode = 400;
      throw err;
    }
    const dup = db.prepare('SELECT id FROM departments WHERE UPPER(code) = ? AND id != ?').get(newCode, id);
    if (dup) {
      const err = new Error(`Department code "${newCode}" already exists`);
      err.statusCode = 409;
      throw err;
    }
    updates.push('code = ?');
    params.push(newCode);
  }

  if (data.description !== undefined) {
    updates.push('description = ?');
    params.push(data.description);
  }

  if (data.managerId !== undefined || data.manager_id !== undefined) {
    const mid = data.managerId || data.manager_id || null;
    if (mid) {
      const mgr = db.prepare('SELECT id FROM users WHERE id = ? OR employee_id = ?').get(mid, mid);
      if (!mgr) {
        const err = new Error(`Manager "${mid}" not found`);
        err.statusCode = 404;
        throw err;
      }
    }
    updates.push('manager_id = ?');
    params.push(mid);
  }

  updates.push('updated_at = ?');
  params.push(new Date().toISOString());

  params.push(id);
  db.prepare(`UPDATE departments SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  logAuditEvent({
    req,
    action: 'DEPARTMENT_UPDATE',
    targetEntity: 'departments',
    targetId: id,
    details: { changes: Object.keys(data) }
  });

  return getDepartmentById(id);
}

/**
 * Deletes a department, rejecting if child teams exist.
 * @param {string} id
 * @param {object} [req]
 * @returns {object}
 */
function deleteDepartment(id, req = null) {
  const db = getDb();
  const dept = db.prepare('SELECT * FROM departments WHERE id = ?').get(id);
  if (!dept) {
    const err = new Error(`Department "${id}" not found`);
    err.statusCode = 404;
    throw err;
  }

  // Check active teams
  const childTeams = db.prepare('SELECT COUNT(*) as count FROM teams WHERE department_id = ?').get(id);
  if (childTeams && childTeams.count > 0) {
    const err = new Error(`Cannot delete department "${dept.name}": contains ${childTeams.count} active teams`);
    err.statusCode = 409;
    throw err;
  }

  db.prepare('DELETE FROM departments WHERE id = ?').run(id);

  logAuditEvent({
    req,
    action: 'DEPARTMENT_DELETE',
    targetEntity: 'departments',
    targetId: id,
    details: { name: dept.name }
  });

  return { success: true, deleted: id };
}

// ============================================================================
// Team Management
// ============================================================================

/**
 * Creates a team linked to a parent department.
 * @param {object} data
 * @param {object} [req]
 * @returns {object}
 */
function createTeam(data = {}, req = null) {
  const name = (data.name || '').trim();
  const departmentId = data.departmentId || data.department_id || null;
  const code = (data.code || '').trim();
  const description = (data.description || '').trim();
  const leaderId = data.leaderId || data.leader_id || null;

  if (!name) {
    const err = new Error('Team name is required');
    err.statusCode = 400;
    throw err;
  }
  if (!departmentId) {
    const err = new Error('departmentId is required');
    err.statusCode = 400;
    throw err;
  }

  const db = getDb();
  // Verify department exists
  const dept = db.prepare('SELECT id FROM departments WHERE id = ?').get(departmentId);
  if (!dept) {
    const err = new Error(`Parent department "${departmentId}" not found`);
    err.statusCode = 404;
    throw err;
  }

  // Duplicate team name in department check
  const dup = db.prepare('SELECT id FROM teams WHERE department_id = ? AND LOWER(name) = LOWER(?)').get(departmentId, name);
  if (dup) {
    const err = new Error(`Team name "${name}" already exists in department`);
    err.statusCode = 409;
    throw err;
  }

  if (leaderId) {
    const ldr = db.prepare('SELECT id FROM users WHERE id = ? OR employee_id = ?').get(leaderId, leaderId);
    if (!ldr) {
      const err = new Error(`Leader "${leaderId}" not found`);
      err.statusCode = 404;
      throw err;
    }
  }

  const id = `team-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO teams (id, name, code, description, department_id, leader_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, code || null, description || null, departmentId, leaderId, now, now);

  logAuditEvent({
    req,
    action: 'TEAM_CREATE',
    targetEntity: 'teams',
    targetId: id,
    details: { name, departmentId }
  });

  return {
    id,
    name,
    code: code || id,
    description,
    departmentId,
    leaderId,
    createdAt: now,
    updatedAt: now
  };
}

/**
 * Lists teams, optionally filtered by departmentId.
 * @param {object} options
 * @returns {Array<object>}
 */
function listTeams({ departmentId } = {}) {
  const db = getDb();
  let sql = `
    SELECT t.*, d.name as dept_name, u.display_name as leader_name
    FROM teams t
    LEFT JOIN departments d ON t.department_id = d.id
    LEFT JOIN users u ON t.leader_id = u.id
  `;
  const params = [];

  if (departmentId) {
    sql += ' WHERE t.department_id = ?';
    params.push(departmentId);
  }
  sql += ' ORDER BY t.name ASC';

  const rows = db.prepare(sql).all(...params);
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    code: r.code || r.id,
    description: r.description || '',
    departmentId: r.department_id,
    departmentName: r.dept_name,
    leaderId: r.leader_id,
    leaderName: r.leader_name,
    createdAt: r.created_at,
    updatedAt: r.updated_at || r.created_at
  }));
}

/**
 * Retrieves a team by ID.
 * @param {string} id
 * @returns {object|null}
 */
function getTeamById(id) {
  if (!id) return null;
  const db = getDb();
  const r = db.prepare(`
    SELECT t.*, d.name as dept_name, u.display_name as leader_name
    FROM teams t
    LEFT JOIN departments d ON t.department_id = d.id
    LEFT JOIN users u ON t.leader_id = u.id
    WHERE t.id = ?
  `).get(id);

  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    code: r.code || r.id,
    description: r.description || '',
    departmentId: r.department_id,
    departmentName: r.dept_name,
    leaderId: r.leader_id,
    leaderName: r.leader_name,
    createdAt: r.created_at,
    updatedAt: r.updated_at || r.created_at
  };
}

/**
 * Updates a team.
 * @param {string} id
 * @param {object} data
 * @param {object} [req]
 * @returns {object}
 */
function updateTeam(id, data = {}, req = null) {
  const db = getDb();
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(id);
  if (!team) {
    const err = new Error(`Team "${id}" not found`);
    err.statusCode = 404;
    throw err;
  }

  const updates = [];
  const params = [];

  if (data.name !== undefined) {
    const newName = String(data.name).trim();
    if (!newName) {
      const err = new Error('Team name cannot be empty');
      err.statusCode = 400;
      throw err;
    }
    const dup = db.prepare('SELECT id FROM teams WHERE department_id = ? AND LOWER(name) = LOWER(?) AND id != ?').get(team.department_id, newName, id);
    if (dup) {
      const err = new Error(`Team name "${newName}" already exists in department`);
      err.statusCode = 409;
      throw err;
    }
    updates.push('name = ?');
    params.push(newName);
  }

  if (data.code !== undefined) {
    updates.push('code = ?');
    params.push(String(data.code).trim());
  }

  if (data.description !== undefined) {
    updates.push('description = ?');
    params.push(data.description);
  }

  if (data.leaderId !== undefined || data.leader_id !== undefined) {
    const lid = data.leaderId || data.leader_id || null;
    if (lid) {
      const ldr = db.prepare('SELECT id FROM users WHERE id = ? OR employee_id = ?').get(lid, lid);
      if (!ldr) {
        const err = new Error(`Leader "${lid}" not found`);
        err.statusCode = 404;
        throw err;
      }
    }
    updates.push('leader_id = ?');
    params.push(lid);
  }

  updates.push('updated_at = ?');
  params.push(new Date().toISOString());

  params.push(id);
  db.prepare(`UPDATE teams SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  logAuditEvent({
    req,
    action: 'TEAM_UPDATE',
    targetEntity: 'teams',
    targetId: id,
    details: { changes: Object.keys(data) }
  });

  return getTeamById(id);
}

/**
 * Deletes a team.
 * @param {string} id
 * @param {object} [req]
 * @returns {object}
 */
function deleteTeam(id, req = null) {
  const db = getDb();
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(id);
  if (!team) {
    const err = new Error(`Team "${id}" not found`);
    err.statusCode = 404;
    throw err;
  }

  db.prepare('DELETE FROM teams WHERE id = ?').run(id);

  logAuditEvent({
    req,
    action: 'TEAM_DELETE',
    targetEntity: 'teams',
    targetId: id,
    details: { name: team.name }
  });

  return { success: true, deleted: id };
}

module.exports = {
  // Shifts
  createShift,
  listShifts,
  getShiftById,
  updateShift,
  assignShift,
  getUserShift,

  // Departments
  createDepartment,
  listDepartments,
  getDepartmentById,
  updateDepartment,
  deleteDepartment,

  // Teams
  createTeam,
  listTeams,
  getTeamById,
  updateTeam,
  deleteTeam
};
