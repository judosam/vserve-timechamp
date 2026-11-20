/**
 * VserveTimeChamp Attendance Correction Service
 * Pure Node.js (zero external dependencies)
 * Handles punch corrections, review workflows, retroactive timesheet recalculations, and audit logging.
 */

const { getDb, transaction } = require('../db/index');
const { logAuditEvent, AUDIT_ACTIONS } = require('./auditService');
const { scopeQuery } = require('../middleware/rbac');

/**
 * Submits an attendance punch correction request.
 * @param {object} currentUser
 * @param {object} data
 * @param {object} [req]
 * @returns {object}
 */
function submitCorrection(currentUser, data = {}, req = null) {
  const { sessionId, session_id, requestedClockIn, requested_clock_in, requestedClockOut, requested_clock_out, reason } = data;
  const targetSessionId = sessionId || session_id;
  const reqIn = requestedClockIn || requested_clock_in;
  const reqOut = requestedClockOut || requested_clock_out;

  // 1. Validations
  if (!targetSessionId) {
    const err = new Error('sessionId is required');
    err.statusCode = 400;
    throw err;
  }
  if (!reason || !String(reason).trim()) {
    const err = new Error('Correction reason is required and cannot be empty');
    err.statusCode = 400;
    throw err;
  }
  if (!reqIn) {
    const err = new Error('requestedClockIn timestamp is required');
    err.statusCode = 400;
    throw err;
  }

  const inTime = new Date(reqIn).getTime();
  if (isNaN(inTime)) {
    const err = new Error('Invalid requestedClockIn timestamp format');
    err.statusCode = 400;
    throw err;
  }
  if (inTime > Date.now() + 86400000) {
    const err = new Error('requestedClockIn cannot be in the future');
    err.statusCode = 400;
    throw err;
  }

  let outTime = null;
  if (reqOut) {
    outTime = new Date(reqOut).getTime();
    if (isNaN(outTime)) {
      const err = new Error('Invalid requestedClockOut timestamp format');
      err.statusCode = 400;
      throw err;
    }
    if (outTime < inTime) {
      const err = new Error('requestedClockOut cannot be earlier than requestedClockIn');
      err.statusCode = 400;
      throw err;
    }
    if (outTime > Date.now() + 86400000) {
      const err = new Error('requestedClockOut cannot be in the future');
      err.statusCode = 400;
      throw err;
    }
  }

  const db = getDb();
  // 2. Session verification
  const session = db.prepare('SELECT * FROM attendance_sessions WHERE id = ?').get(targetSessionId);
  if (!session) {
    const err = new Error(`Attendance session "${targetSessionId}" not found`);
    err.statusCode = 404;
    throw err;
  }

  // 3. Authorization check: Employees can only submit corrections for their own sessions
  if (currentUser && currentUser.role === 'EMPLOYEE' && session.user_id !== currentUser.id) {
    const err = new Error("Forbidden: Cannot submit correction on another employee's session");
    err.statusCode = 403;
    throw err;
  }

  // 4. Duplicate pending correction check
  const existingPending = db.prepare("SELECT id FROM attendance_corrections WHERE session_id = ? AND status = 'PENDING'").get(targetSessionId);
  if (existingPending) {
    const err = new Error(`A correction request for session "${targetSessionId}" is already PENDING`);
    err.statusCode = 409;
    throw err;
  }

  const id = `corr-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
  const now = new Date().toISOString();
  const userId = session.user_id;

  db.prepare(`
    INSERT INTO attendance_corrections (
      id, session_id, user_id, original_clock_in, original_clock_out,
      requested_clock_in, requested_clock_out, reason, status, applied_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)
  `).run(
    id, targetSessionId, userId, session.clock_in, session.clock_out || null,
    reqIn, reqOut || null, String(reason).trim(), now
  );

  logAuditEvent({
    req,
    action: AUDIT_ACTIONS.CORRECTION_SUBMIT || 'CORRECTION_SUBMIT',
    targetEntity: 'attendance_corrections',
    targetId: id,
    details: { sessionId: targetSessionId, requestedClockIn: reqIn, requestedClockOut: reqOut }
  });

  return {
    id,
    sessionId: targetSessionId,
    userId,
    originalClockIn: session.clock_in,
    originalClockOut: session.clock_out,
    requestedClockIn: reqIn,
    requestedClockOut: reqOut || null,
    reason: String(reason).trim(),
    status: 'PENDING',
    appliedAt: now
  };
}

/**
 * Lists attendance corrections with role-based scoping and filters.
 * @param {object} options
 * @returns {object}
 */
function listCorrections({
  currentUser,
  status,
  sessionId,
  userId,
  limit = 50,
  offset = 0
} = {}) {
  const db = getDb();
  const limitNum = Math.max(1, parseInt(limit, 10) || 50);
  const offsetNum = Math.max(0, parseInt(offset, 10) || 0);

  const conditions = [];
  const params = [];

  if (currentUser) {
    const scope = scopeQuery(currentUser, 'corrections', 'c');
    if (scope && scope.whereClause) {
      conditions.push(scope.whereClause);
      params.push(...scope.params);
    }
  }

  if (status) {
    conditions.push('c.status = ?');
    params.push(String(status).toUpperCase().trim());
  }

  if (sessionId) {
    conditions.push('c.session_id = ?');
    params.push(sessionId);
  }

  if (userId) {
    conditions.push('c.user_id = ?');
    params.push(userId);
  }

  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const totalRow = db.prepare(`
    SELECT COUNT(*) as count
    FROM attendance_corrections c
    JOIN users u ON c.user_id = u.id
    ${whereSql}
  `).get(...params);

  const total = totalRow ? totalRow.count : 0;

  const rows = db.prepare(`
    SELECT c.*, u.display_name, u.employee_id, u.department_id, s.clock_in as orig_in, s.clock_out as orig_out
    FROM attendance_corrections c
    JOIN users u ON c.user_id = u.id
    LEFT JOIN attendance_sessions s ON c.session_id = s.id
    ${whereSql}
    ORDER BY c.applied_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limitNum, offsetNum);

  return {
    corrections: rows.map(r => ({
      id: r.id,
      sessionId: r.session_id,
      userId: r.user_id,
      employeeId: r.employee_id,
      displayName: r.display_name,
      originalClockIn: r.original_clock_in || r.orig_in,
      originalClockOut: r.original_clock_out || r.orig_out,
      requestedClockIn: r.requested_clock_in,
      requestedClockOut: r.requested_clock_out,
      reason: r.reason,
      status: r.status,
      reviewerId: r.reviewer_id,
      reviewerNotes: r.reviewer_notes,
      appliedAt: r.applied_at,
      resolvedAt: r.resolved_at
    })),
    total,
    limit: limitNum,
    offset: offsetNum
  };
}

/**
 * Reviews (approves or rejects) an attendance correction request.
 * Retroactively recalculates timesheet durations upon approval while preserving breaks.
 * @param {string} correctionId
 * @param {object} reviewerUser
 * @param {object} data
 * @param {object} [req]
 * @returns {object}
 */
function reviewCorrection(correctionId, reviewerUser, data = {}, req = null) {
  if (!reviewerUser) {
    const err = new Error('Authentication required to review corrections');
    err.statusCode = 401;
    throw err;
  }

  if (reviewerUser.role === 'EMPLOYEE') {
    const err = new Error('Forbidden: Employees cannot review correction requests');
    err.statusCode = 403;
    throw err;
  }

  const targetStatus = (data.status || data.action || '').toUpperCase().trim();
  if (!['APPROVED', 'REJECTED'].includes(targetStatus)) {
    const err = new Error('Review status must be either APPROVED or REJECTED');
    err.statusCode = 400;
    throw err;
  }

  const db = getDb();
  const corr = db.prepare(`
    SELECT c.*, u.department_id, u.target_daily_hours
    FROM attendance_corrections c
    JOIN users u ON c.user_id = u.id
    WHERE c.id = ?
  `).get(correctionId);

  if (!corr) {
    const err = new Error(`Correction request "${correctionId}" not found`);
    err.statusCode = 404;
    throw err;
  }

  if (corr.status !== 'PENDING') {
    const err = new Error(`Cannot review correction that is already ${corr.status}`);
    err.statusCode = 409;
    throw err;
  }

  // Cross-department check for Manager
  if (reviewerUser.role === 'MANAGER') {
    if (corr.department_id !== reviewerUser.departmentId) {
      const err = new Error('Forbidden: Cannot review corrections for employees outside your department');
      err.statusCode = 403;
      throw err;
    }
  }

  const notes = data.reviewerComments || data.comments || data.reviewerNotes || '';
  const now = new Date().toISOString();

  transaction(() => {
    // 1. Update correction record
    db.prepare(`
      UPDATE attendance_corrections
      SET status = ?, reviewer_id = ?, reviewer_notes = ?, resolved_at = ?
      WHERE id = ?
    `).run(targetStatus, reviewerUser.id, notes, now, correctionId);

    // 2. Upon approval, retroactively update attendance_sessions and recalculate timesheet math
    if (targetStatus === 'APPROVED') {
      const inMs = new Date(corr.requested_clock_in).getTime();
      const outMs = corr.requested_clock_out ? new Date(corr.requested_clock_out).getTime() : inMs;
      const grossSec = Math.max(0, Math.floor((outMs - inMs) / 1000));

      // Strictly preserve recorded breaks associated with the session
      const breaks = db.prepare('SELECT duration, is_paid FROM attendance_breaks WHERE session_id = ?').all(corr.session_id);
      const unpaidBreakSec = breaks.reduce((acc, b) => {
        if (b.is_paid === 0 || !b.is_paid) {
          return acc + (b.duration || 0);
        }
        return acc;
      }, 0);

      const netSec = Math.max(0, grossSec - unpaidBreakSec);
      const targetSec = (corr.target_daily_hours || 8.0) * 3600;

      let overtimeMinutes = 0;
      let shortfallMinutes = 0;

      if (netSec > targetSec) {
        overtimeMinutes = Math.floor((netSec - targetSec) / 60);
      } else if (netSec < targetSec) {
        shortfallMinutes = Math.floor((targetSec - netSec) / 60);
      }

      db.prepare(`
        UPDATE attendance_sessions
        SET clock_in = ?, clock_out = ?, gross_duration = ?, net_duration = ?,
            overtime_minutes = ?, shortfall_minutes = ?, status = 'COMPLETED'
        WHERE id = ?
      `).run(
        corr.requested_clock_in,
        corr.requested_clock_out || corr.requested_clock_in,
        grossSec,
        netSec,
        overtimeMinutes,
        shortfallMinutes,
        corr.session_id
      );
    }
  });

  // 3. Immutable audit log entry with action 'CORRECTION_APPROVED' or 'CORRECTION_REJECTED'
  logAuditEvent({
    req,
    action: targetStatus === 'APPROVED' ? 'CORRECTION_APPROVED' : 'CORRECTION_REJECTED',
    targetEntity: 'attendance_corrections',
    targetId: correctionId,
    details: {
      status: targetStatus,
      sessionId: corr.session_id,
      notes,
      requestedClockIn: corr.requested_clock_in,
      requestedClockOut: corr.requested_clock_out
    }
  });

  return {
    id: corr.id,
    sessionId: corr.session_id,
    userId: corr.user_id,
    status: targetStatus,
    reviewerId: reviewerUser.id,
    reviewerNotes: notes,
    resolvedAt: now
  };
}

/**
 * Calculates timesheet adjustment preview given original/corrected times and breaks.
 * @param {object} data
 * @returns {object}
 */
function calculateAdjustment(data = {}) {
  const { targetHours = 8.0, breaks = [] } = data;
  const inStr = data.requestedClockIn || data.originalClockIn || data.clockIn;
  const outStr = data.requestedClockOut || data.correctedClockOut || data.originalClockOut || data.clockOut;

  const inTime = inStr ? new Date(inStr).getTime() : Date.now();
  const outTime = outStr ? new Date(outStr).getTime() : inTime;
  const grossHours = Math.max(0, (outTime - inTime) / (1000 * 3600));

  let breakHours = 0;
  if (Array.isArray(breaks)) {
    breakHours = breaks.reduce((acc, b) => {
      if (b.durationSeconds !== undefined) {
        return acc + (b.durationSeconds / 3600);
      }
      if (b.duration !== undefined) {
        return acc + (b.duration / 3600);
      }
      if (b.startTime && b.endTime) {
        const ms = new Date(b.endTime).getTime() - new Date(b.startTime).getTime();
        return acc + Math.max(0, ms / (1000 * 3600));
      }
      return acc;
    }, 0);
  }

  const netHours = Math.max(0, grossHours - breakHours);
  const target = parseFloat(targetHours || 8.0);
  let overtimeMinutes = 0;
  let shortfallMinutes = 0;

  if (netHours > target) {
    overtimeMinutes = Math.round((netHours - target) * 60);
  } else if (netHours < target) {
    shortfallMinutes = Math.round((target - netHours) * 60);
  }

  return {
    success: true,
    grossHours,
    grossSeconds: Math.round(grossHours * 3600),
    totalBreakHours: breakHours,
    breakHours,
    totalBreakSeconds: Math.round(breakHours * 3600),
    breakSeconds: Math.round(breakHours * 3600),
    netHours,
    netSeconds: Math.round(netHours * 3600),
    overtimeMinutes,
    shortfallMinutes
  };
}

module.exports = {
  submitCorrection,
  listCorrections,
  reviewCorrection,
  calculateAdjustment
};
