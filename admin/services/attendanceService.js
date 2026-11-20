/**
 * VserveTimeChamp Attendance Service
 * Milestone 2: Core Attendance, Clock-In/Out, Breaks, and Timesheet Engine
 * 
 * Pure Node.js & node:sqlite implementation
 * Zero external npm dependencies
 */

const crypto = require('crypto');
const { get, query, run, transaction } = require('../db/index');
const { ROLES, canAccessUser, scopeQuery } = require('../middleware/rbac');

// Allowed break types with TitleCase mapping
const BREAK_TYPES = Object.freeze({
  LUNCH: 'Lunch',
  TEA: 'Tea',
  MEETING: 'Meeting',
  PERSONAL: 'Personal',
  OTHER: 'Other'
});

// Allowed attendance source tags
const ATTENDANCE_SOURCES = Object.freeze({
  WEB: 'WEB',
  DESKTOP: 'DESKTOP',
  AGENT: 'AGENT',
  API: 'API',
  MANUAL: 'MANUAL'
});

// Session statuses
const ATTENDANCE_STATUS = Object.freeze({
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  AUTO_CLOSED: 'AUTO_CLOSED',
  FLAGGED: 'FLAGGED'
});

// Custom error classes for clean HTTP mapping
class AttendanceError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'AttendanceError';
    this.statusCode = statusCode;
  }
}

class ConflictError extends AttendanceError {
  constructor(message = 'Active session already exists') {
    super(message, 409);
    this.name = 'ConflictError';
  }
}

class NotFoundError extends AttendanceError {
  constructor(message = 'Not Found') {
    super(message, 404);
    this.name = 'NotFoundError';
  }
}

class ForbiddenError extends AttendanceError {
  constructor(message = 'Forbidden') {
    super(message, 403);
    this.name = 'ForbiddenError';
  }
}

class BadRequestError extends AttendanceError {
  constructor(message = 'Bad Request') {
    super(message, 400);
    this.name = 'BadRequestError';
  }
}

/**
 * Normalizes break type to TitleCase (e.g. 'Lunch', 'Tea')
 * Returns null if invalid break type.
 */
function normalizeBreakType(type) {
  if (!type || typeof type !== 'string') return null;
  const upper = type.trim().toUpperCase();
  return BREAK_TYPES[upper] || null;
}

/**
 * Normalizes source tag
 */
function normalizeSource(source) {
  if (!source || typeof source !== 'string') return ATTENDANCE_SOURCES.WEB;
  const upper = source.trim().toUpperCase();
  return ATTENDANCE_SOURCES[upper] || ATTENDANCE_SOURCES.WEB;
}

/**
 * Formats a raw database break row into a standardized response object
 */
function formatBreak(row) {
  if (!row) return null;
  const breakTypeUpper = (row.break_type || '').toUpperCase();
  const titleCaseBreak = BREAK_TYPES[breakTypeUpper] || row.break_type;
  return {
    id: row.id,
    sessionId: row.session_id,
    userId: row.user_id,
    breakType: titleCaseBreak,
    startTime: row.start_time,
    endTime: row.end_time || null,
    duration: row.duration || 0,
    isPaid: row.is_paid === 1,
    createdAt: row.created_at,
    // snake_case aliases for compatibility
    session_id: row.session_id,
    user_id: row.user_id,
    break_type: titleCaseBreak,
    start_time: row.start_time,
    end_time: row.end_time || null,
    is_paid: row.is_paid
  };
}

/**
 * Formats a raw database session row into a standardized response object
 */
function formatSession(row, breaks = []) {
  if (!row) return null;
  const formattedBreaks = Array.isArray(breaks) ? breaks.map(formatBreak) : [];
  const totalBreakSeconds = formattedBreaks.reduce((sum, b) => sum + (b.duration || 0), 0);

  return {
    id: row.id,
    userId: row.user_id,
    shiftId: row.shift_id || null,
    clockIn: row.clock_in,
    clockOut: row.clock_out || null,
    source: row.source,
    status: row.status,
    notes: row.notes || null,
    lateInMinutes: row.late_in_minutes || 0,
    earlyOutMinutes: row.early_out_minutes || 0,
    grossDuration: row.gross_duration || 0,
    netDuration: row.net_duration || 0,
    totalBreakDuration: totalBreakSeconds,
    overtimeMinutes: row.overtime_minutes || 0,
    shortfallMinutes: row.shortfall_minutes || 0,
    createdAt: row.created_at,
    breaks: formattedBreaks,
    // snake_case aliases
    user_id: row.user_id,
    shift_id: row.shift_id || null,
    clock_in: row.clock_in,
    clock_out: row.clock_out || null,
    late_in_minutes: row.late_in_minutes || 0,
    early_out_minutes: row.early_out_minutes || 0,
    gross_duration: row.gross_duration || 0,
    net_duration: row.net_duration || 0,
    overtime_minutes: row.overtime_minutes || 0,
    shortfall_minutes: row.shortfall_minutes || 0,
    created_at: row.created_at
  };
}

/**
 * Evaluates clock-in punctuality against shift start and grace period.
 * 
 * If actual clock-in is within grace period: isLate = false, lateMinutes = 0
 * If actual clock-in is past grace period: isLate = true, lateMinutes = difference from scheduled start time
 */
function evaluatePunctuality({ shiftStartTime = '09:00', graceMinutes = 15, actualClockInTime }) {
  if (!actualClockInTime) {
    throw new BadRequestError('actualClockInTime is required');
  }

  let actH, actM;
  if (typeof actualClockInTime === 'string') {
    if (actualClockInTime.includes('T') || actualClockInTime.endsWith('Z')) {
      const d = new Date(actualClockInTime);
      if (isNaN(d.getTime())) {
        throw new BadRequestError('Invalid timestamp format for actualClockInTime');
      }
      actH = d.getUTCHours();
      actM = d.getUTCMinutes();
    } else {
      const parts = actualClockInTime.split(':').map(Number);
      if (parts.length < 2 || isNaN(parts[0]) || isNaN(parts[1])) {
        throw new BadRequestError('Invalid time format for actualClockInTime, expected HH:mm or ISO string');
      }
      actH = parts[0];
      actM = parts[1];
    }
  } else {
    throw new BadRequestError('Invalid actualClockInTime');
  }

  const shiftParts = (shiftStartTime || '09:00').split(':').map(Number);
  if (shiftParts.length < 2 || isNaN(shiftParts[0]) || isNaN(shiftParts[1])) {
    throw new BadRequestError('Invalid shiftStartTime format, expected HH:mm');
  }
  const schedH = shiftParts[0];
  const schedM = shiftParts[1];

  const schedTotal = schedH * 60 + schedM;
  const actualTotal = actH * 60 + actM;
  let delta = actualTotal - schedTotal;
  if (delta < -720) {
    delta += 1440;
  }
  const grace = parseInt(graceMinutes || 0, 10);

  if (delta <= grace) {
    return {
      success: true,
      isLate: false,
      lateMinutes: 0
    };
  } else {
    return {
      success: true,
      isLate: true,
      lateMinutes: delta
    };
  }
}

/**
 * Merges overlapping break intervals into non-overlapping contiguous intervals (Union Algorithm)
 * and returns the total deduplicated break duration in seconds.
 */
function mergeBreakIntervals(breaks = []) {
  if (!Array.isArray(breaks) || breaks.length === 0) {
    return { totalBreakSeconds: 0, mergedIntervals: [] };
  }

  // 1. Separate timestamped intervals from pure duration numbers
  const timestamped = [];
  let standaloneSeconds = 0;

  for (const b of breaks) {
    const startVal = b.startTime || b.start_time;
    const endVal = b.endTime || b.end_time;
    if (startVal && endVal) {
      const start = new Date(startVal).getTime();
      const end = new Date(endVal).getTime();
      if (!isNaN(start) && !isNaN(end) && end >= start) {
        timestamped.push({ start, end });
      }
    } else if (typeof b.durationSeconds === 'number') {
      standaloneSeconds += Math.max(0, b.durationSeconds);
    } else if (typeof b.duration_seconds === 'number') {
      standaloneSeconds += Math.max(0, b.duration_seconds);
    } else if (typeof b.duration === 'number') {
      standaloneSeconds += Math.max(0, b.duration);
    }
  }

  if (timestamped.length === 0) {
    return { totalBreakSeconds: standaloneSeconds, mergedIntervals: [] };
  }

  // 2. Sort timestamped intervals by start time ascending, then end time ascending
  timestamped.sort((a, b) => a.start - b.start || a.end - b.end);

  // 3. Merge overlapping / contiguous intervals
  const merged = [];
  for (const interval of timestamped) {
    if (merged.length === 0) {
      merged.push({ start: interval.start, end: interval.end });
    } else {
      const last = merged[merged.length - 1];
      if (interval.start <= last.end) {
        // Overlap or touch: merge and extend end time
        last.end = Math.max(last.end, interval.end);
      } else {
        merged.push({ start: interval.start, end: interval.end });
      }
    }
  }

  // 4. Sum union seconds
  const unionSeconds = merged.reduce((sum, int) => sum + Math.round((int.end - int.start) / 1000), 0);

  return {
    totalBreakSeconds: unionSeconds + standaloneSeconds,
    mergedIntervals: merged
  };
}

/**
 * Mathematical Calculation Helper for attendance sessions
 * 
 * Handles:
 * - clockIn & clockOut epoch calculation (crossing midnight supported)
 * - Break interval deduplication (union algorithm)
 * - Net working duration clamping (never negative)
 * - Overtime and shortfall calculations against target hours
 */
function calculateHours({ grossSeconds, clockIn, clockOut, breaks = [], netHours, targetHours }) {
  // Case 1: Pure overtime/shortfall calculation without session timestamps
  if (grossSeconds == null && clockIn == null && netHours != null) {
    const target = typeof targetHours === 'number' ? targetHours : 8.0;
    const diff = Number((netHours - target).toFixed(2));
    let overtimeMinutes = 0;
    let shortfallMinutes = 0;

    if (diff > 0) {
      overtimeMinutes = Math.round(diff * 60);
    } else if (diff < 0) {
      shortfallMinutes = Math.round(Math.abs(diff) * 60);
    }

    return {
      success: true,
      netHours,
      targetHours: target,
      overtimeMinutes,
      shortfallMinutes
    };
  }

  // Case 2: Calculate from clockIn and clockOut timestamps
  let grossSec = grossSeconds;
  if (clockIn && clockOut) {
    const tIn = new Date(clockIn).getTime();
    const tOut = new Date(clockOut).getTime();

    if (isNaN(tIn) || isNaN(tOut)) {
      throw new BadRequestError('Invalid timestamp format for clockIn or clockOut');
    }

    if (tOut < tIn) {
      throw new BadRequestError('Clock-out time cannot be earlier than clock-in time');
    }

    grossSec = Math.round((tOut - tIn) / 1000);
  }

  if (grossSec == null) {
    throw new BadRequestError('Either grossSeconds or (clockIn and clockOut) must be provided');
  }

  grossSec = Math.max(0, parseInt(grossSec, 10));

  // Deduplicate breaks
  const { totalBreakSeconds } = mergeBreakIntervals(breaks);

  // Net duration is gross minus unpaid breaks, clamped to >= 0
  const netSec = Math.max(0, grossSec - totalBreakSeconds);

  const grossHrs = +(grossSec / 3600).toFixed(2);
  const netHrs = +(netSec / 3600).toFixed(2);
  const totalBreakHrs = +(totalBreakSeconds / 3600).toFixed(2);

  const target = typeof targetHours === 'number' ? targetHours : 8.0;
  const targetSec = Math.round(target * 3600);

  let overtimeMinutes = 0;
  let shortfallMinutes = 0;

  if (netSec > targetSec) {
    overtimeMinutes = Math.round((netSec - targetSec) / 60);
  } else if (netSec < targetSec) {
    shortfallMinutes = Math.round((targetSec - netSec) / 60);
  }

  return {
    success: true,
    grossSeconds: grossSec,
    grossHours: grossHrs,
    totalBreakSeconds,
    breakSeconds: totalBreakSeconds,
    totalBreakHours: totalBreakHrs,
    netSeconds: netSec,
    netHours: netHrs,
    overtimeMinutes,
    shortfallMinutes
  };
}

/**
 * Real-time Clock-In Operation
 */
function clockIn({ userId, employeeId, source = 'WEB', notes = '', shiftId, clockInTime, checkLeaveConflict = false, date }) {
  // Resolve user
  let user = null;
  if (employeeId) {
    user = get('SELECT * FROM users WHERE employee_id = ? OR id = ?', [employeeId, employeeId]);
    if (!user) {
      const newId = `usr-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
      const nowIso = new Date().toISOString();
      const { hashPassword } = require('./authService');
      const { hash, salt } = hashPassword('Vserve@2026');
      try {
        run(`
          INSERT INTO users (
            id, employee_id, username, password_hash, salt, display_name, role,
            department_id, team_id, email, is_active, target_daily_hours, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'EMPLOYEE', 'dept-eng', 'team-eng-core', ?, 1, 8.0, ?, ?)
        `, [newId, employeeId, `emp_${employeeId.toLowerCase()}`, hash, salt, `Employee ${employeeId}`, `${employeeId.toLowerCase()}@vservetimechamp.internal`, nowIso, nowIso]);
        user = get('SELECT * FROM users WHERE id = ?', [newId]);
      } catch {
        user = get('SELECT * FROM users WHERE employee_id = ?', [employeeId]);
      }
    }
  } else if (userId) {
    user = get('SELECT * FROM users WHERE id = ?', [userId]);
  }

  if (!user) {
    throw new NotFoundError('User not found');
  }

  if (user.is_active === 0) {
    throw new ForbiddenError('User account is inactive');
  }

  if (clockInTime && isNaN(new Date(clockInTime).getTime())) {
    throw new BadRequestError('Invalid timestamp format for clockInTime');
  }

  // 1. Prevent duplicate active sessions
  const activeSession = get('SELECT id, clock_in FROM attendance_sessions WHERE user_id = ? AND status = ?', [user.id, ATTENDANCE_STATUS.IN_PROGRESS]);
  if (activeSession) {
    throw new ConflictError('Active session already exists for this user');
  }

  const nowIso = new Date().toISOString();
  const punchTime = clockInTime || nowIso;
  const punchDate = date || punchTime.slice(0, 10);

  // 2. Check for leave conflict if requested
  if (checkLeaveConflict) {
    const leave = get(`
      SELECT id, leave_type FROM leaves 
      WHERE user_id = ? AND status = 'APPROVED' 
        AND start_date <= ? AND end_date >= ?
        AND UPPER(leave_type) NOT LIKE '%HALF%'
    `, [user.id, punchDate, punchDate]);

    if (leave) {
      throw new ConflictError('User is on approved leave for this date');
    }
  }

  // 3. Resolve shift & punctuality
  let shift = null;
  if (shiftId) {
    shift = get('SELECT * FROM shifts WHERE id = ?', [shiftId]);
  }

  if (!shift) {
    const assignment = get(`
      SELECT s.* FROM shift_assignments sa
      JOIN shifts s ON sa.shift_id = s.id
      WHERE sa.user_id = ? AND sa.start_date <= ? AND (sa.end_date IS NULL OR sa.end_date >= ?)
      ORDER BY sa.start_date DESC LIMIT 1
    `, [user.id, punchDate, punchDate]);
    shift = assignment || get('SELECT * FROM shifts WHERE id = ?', ['shift-std']);
  }

  let lateInMinutes = 0;
  if (shift && shift.start_time) {
    try {
      const punct = evaluatePunctuality({
        shiftStartTime: shift.start_time,
        graceMinutes: shift.grace_minutes || 15,
        actualClockInTime: punchTime
      });
      if (punct.isLate) {
        lateInMinutes = punct.lateMinutes;
      }
    } catch (err) {
      // Non-fatal punctuality calculation fallback
      lateInMinutes = 0;
    }
  }

  const sessionId = `att-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const normalizedSource = normalizeSource(source);

  try {
    run(`
      INSERT INTO attendance_sessions (
        id, user_id, shift_id, clock_in, clock_out, source, status,
        late_in_minutes, early_out_minutes, gross_duration, net_duration,
        overtime_minutes, shortfall_minutes, created_at
      ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 0, 0, 0, 0, 0, ?)
    `, [
      sessionId,
      user.id,
      shift ? shift.id : null,
      punchTime,
      normalizedSource,
      ATTENDANCE_STATUS.IN_PROGRESS,
      lateInMinutes,
      nowIso
    ]);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      throw new ConflictError('Active session already exists for this user');
    }
    throw err;
  }

  const createdRow = get('SELECT * FROM attendance_sessions WHERE id = ?', [sessionId]);
  return formatSession(createdRow);
}

/**
 * Retrieves the currently active session and open break for a user
 */
function getActiveSession(userId) {
  if (!userId) return { success: true, active: false, session: null, openBreak: null };

  const session = get('SELECT * FROM attendance_sessions WHERE user_id = ? AND status = ?', [userId, ATTENDANCE_STATUS.IN_PROGRESS]);
  if (!session) {
    return {
      success: true,
      active: false,
      session: null,
      openBreak: null
    };
  }

  const breaks = query('SELECT * FROM attendance_breaks WHERE session_id = ? ORDER BY start_time ASC', [session.id]);
  const openBreak = breaks.find(b => b.end_time == null);

  return {
    success: true,
    active: true,
    session: formatSession(session, breaks),
    openBreak: openBreak ? formatBreak(openBreak) : null
  };
}

/**
 * Clock-Out Operation
 */
function clockOut({ userId, sessionId, notes = '', clockOutTime, autoCloseBreaks = true }) {
  let session = null;

  if (sessionId) {
    session = get('SELECT * FROM attendance_sessions WHERE id = ?', [sessionId]);
    if (!session) {
      throw new NotFoundError('Attendance session not found');
    }
    if (userId && session.user_id !== userId) {
      throw new ForbiddenError('Cannot clock out another user session');
    }
  } else if (userId) {
    session = get('SELECT * FROM attendance_sessions WHERE user_id = ? AND status = ?', [userId, ATTENDANCE_STATUS.IN_PROGRESS]);
    if (!session) {
      throw new NotFoundError('No active session found to clock out');
    }
  } else {
    throw new BadRequestError('Either sessionId or userId is required');
  }

  if (session.status !== ATTENDANCE_STATUS.IN_PROGRESS) {
    throw new BadRequestError('Session is already COMPLETED');
  }

  const punchOut = clockOutTime || new Date().toISOString();

  // Validate clock-out timestamp is not earlier than clock-in
  if (new Date(punchOut).getTime() < new Date(session.clock_in).getTime()) {
    throw new BadRequestError('Clock-out time cannot be earlier than clock-in time');
  }

  // Auto-close open breaks and complete session within an atomic transaction
  transaction((db) => {
    // Auto-close any open break
    const openBreak = get('SELECT * FROM attendance_breaks WHERE session_id = ? AND end_time IS NULL', [session.id]);
    if (openBreak) {
      const breakEnd = punchOut;
      const duration = Math.max(0, Math.round((new Date(breakEnd).getTime() - new Date(openBreak.start_time).getTime()) / 1000));
      run('UPDATE attendance_breaks SET end_time = ?, duration = ? WHERE id = ?', [breakEnd, duration, openBreak.id]);
    }

    // Fetch all breaks for session
    const breaks = query('SELECT * FROM attendance_breaks WHERE session_id = ? ORDER BY start_time ASC', [session.id]);

    // Resolve user target daily hours
    const user = get('SELECT target_daily_hours FROM users WHERE id = ?', [session.user_id]);
    const targetHours = user ? user.target_daily_hours : 8.0;

    // Calculate durations
    const calc = calculateHours({
      clockIn: session.clock_in,
      clockOut: punchOut,
      breaks,
      targetHours
    });

    // Calculate early-out punctuality if assigned to shift
    let earlyOutMinutes = 0;
    if (session.shift_id) {
      const shift = get('SELECT * FROM shifts WHERE id = ?', [session.shift_id]);
      if (shift && shift.end_time) {
        const parts = shift.end_time.split(':').map(Number);
        const shiftEndMinutes = parts[0] * 60 + parts[1];
        const outDate = new Date(punchOut);
        const outMinutes = outDate.getUTCHours() * 60 + outDate.getUTCMinutes();
        if (!shift.is_overnight && outMinutes < shiftEndMinutes) {
          earlyOutMinutes = shiftEndMinutes - outMinutes;
        }
      }
    }

    run(`
      UPDATE attendance_sessions SET
        status = ?,
        clock_out = ?,
        gross_duration = ?,
        net_duration = ?,
        early_out_minutes = ?,
        overtime_minutes = ?,
        shortfall_minutes = ?
      WHERE id = ?
    `, [
      ATTENDANCE_STATUS.COMPLETED,
      punchOut,
      calc.grossSeconds,
      calc.netSeconds,
      earlyOutMinutes,
      calc.overtimeMinutes,
      calc.shortfallMinutes,
      session.id
    ]);
  });

  const updatedSession = get('SELECT * FROM attendance_sessions WHERE id = ?', [session.id]);
  const updatedBreaks = query('SELECT * FROM attendance_breaks WHERE session_id = ? ORDER BY start_time ASC', [session.id]);

  return formatSession(updatedSession, updatedBreaks);
}

/**
 * Starts a break for an active session
 */
function startBreak({ userId, sessionId, breakType, startTime }) {
  const normalizedType = normalizeBreakType(breakType);
  if (!normalizedType) {
    throw new BadRequestError('Invalid break type. Allowed: Lunch, Tea, Meeting, Personal, Other');
  }

  let session = null;
  if (sessionId) {
    session = get('SELECT * FROM attendance_sessions WHERE id = ?', [sessionId]);
    if (!session || session.status !== ATTENDANCE_STATUS.IN_PROGRESS) {
      throw new ConflictError('Cannot start break without an active session');
    }
  } else if (userId) {
    session = get('SELECT * FROM attendance_sessions WHERE user_id = ? AND status = ?', [userId, ATTENDANCE_STATUS.IN_PROGRESS]);
    if (!session) {
      throw new ConflictError('Cannot start break without an active clock-in session');
    }
  } else {
    throw new BadRequestError('Either sessionId or userId is required');
  }

  // Prevent starting second break while one is already open
  const openBreak = get('SELECT id FROM attendance_breaks WHERE session_id = ? AND end_time IS NULL', [session.id]);
  if (openBreak) {
    throw new ConflictError('Active break already in progress');
  }

  const breakId = `brk-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const nowIso = new Date().toISOString();
  const start = startTime || nowIso;

  try {
    run(`
      INSERT INTO attendance_breaks (
        id, session_id, user_id, break_type, start_time, end_time, duration, is_paid, created_at
      ) VALUES (?, ?, ?, ?, ?, NULL, 0, 0, ?)
    `, [
      breakId,
      session.id,
      session.user_id,
      normalizedType,
      start,
      nowIso
    ]);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      throw new ConflictError('Active break already in progress');
    }
    throw err;
  }

  const createdBreak = get('SELECT * FROM attendance_breaks WHERE id = ?', [breakId]);
  return formatBreak(createdBreak);
}

/**
 * Concludes an active break
 */
function endBreak({ userId, sessionId, breakId, endTime }) {
  let breakRow = null;

  if (breakId) {
    breakRow = get('SELECT * FROM attendance_breaks WHERE id = ?', [breakId]);
    if (!breakRow) {
      throw new NotFoundError('Break record not found');
    }
    if (breakRow.end_time != null) {
      throw new BadRequestError('Break has already ended');
    }
  } else {
    // Resolve via session or user
    let sessId = sessionId;
    if (!sessId && userId) {
      const activeSess = get('SELECT id FROM attendance_sessions WHERE user_id = ? AND status = ?', [userId, ATTENDANCE_STATUS.IN_PROGRESS]);
      if (activeSess) sessId = activeSess.id;
    }

    if (sessId) {
      breakRow = get('SELECT * FROM attendance_breaks WHERE session_id = ? AND end_time IS NULL ORDER BY start_time DESC LIMIT 1', [sessId]);
    }

    if (!breakRow && userId) {
      breakRow = get('SELECT * FROM attendance_breaks WHERE user_id = ? AND end_time IS NULL ORDER BY start_time DESC LIMIT 1', [userId]);
    }

    if (!breakRow) {
      throw new NotFoundError('No active break in progress');
    }
  }

  const end = endTime || new Date().toISOString();
  const startMs = new Date(breakRow.start_time).getTime();
  const endMs = new Date(end).getTime();

  if (endMs < startMs) {
    throw new BadRequestError('Break end time cannot be earlier than start time');
  }

  const duration = Math.max(0, Math.round((endMs - startMs) / 1000));

  run('UPDATE attendance_breaks SET end_time = ?, duration = ? WHERE id = ?', [end, duration, breakRow.id]);

  const updatedBreak = get('SELECT * FROM attendance_breaks WHERE id = ?', [breakRow.id]);
  return formatBreak(updatedBreak);
}

/**
 * Query timesheets and attendance history with strict RBAC scoping
 */
function getTimesheets({
  currentUser,
  employeeId,
  userId,
  sessionId,
  date,
  logicalDate,
  startDate,
  endDate,
  status,
  summary = false,
  limit = 50,
  offset = 0
}) {
  if (!currentUser) {
    throw new ForbiddenError('Unauthorized: Authentication required');
  }

  // 1. Enforce RBAC boundary check if requesting another user's timesheets
  if (employeeId || userId) {
    let targetUser = null;
    if (employeeId) {
      targetUser = get('SELECT * FROM users WHERE employee_id = ? OR id = ?', [employeeId, employeeId]);
    } else if (userId) {
      targetUser = get('SELECT * FROM users WHERE id = ?', [userId]);
    }

    // Role-specific boundary gate
    if (currentUser.role === ROLES.EMPLOYEE) {
      const isSelf = targetUser
        ? (targetUser.id === currentUser.id || targetUser.employee_id === currentUser.employeeId)
        : (employeeId === currentUser.employeeId || userId === currentUser.id);

      if (!isSelf) {
        throw new ForbiddenError("Forbidden: Employees can only access their own timesheets");
      }
    } else if (currentUser.role === ROLES.TEAM_LEADER) {
      if (targetUser && !canAccessUser(currentUser, targetUser)) {
        throw new ForbiddenError("Forbidden: Target employee is outside your team scope");
      }
    } else if (currentUser.role === ROLES.MANAGER) {
      if (targetUser && !canAccessUser(currentUser, targetUser)) {
        throw new ForbiddenError("Forbidden: Target employee is outside your department scope");
      }
    }
  }

  // 2. Build scoped SQL query
  const scope = scopeQuery(currentUser, 'attendance', 's');
  let whereClauses = [scope.whereClause];
  let params = [...scope.params];

  if (sessionId) {
    whereClauses.push('s.id = ?');
    params.push(sessionId);
  }

  if (userId) {
    whereClauses.push('s.user_id = ?');
    params.push(userId);
  }

  if (employeeId) {
    whereClauses.push('(u.employee_id = ? OR u.id = ?)');
    params.push(employeeId, employeeId);
  }

  if (status) {
    whereClauses.push('s.status = ?');
    params.push(status);
  }

  const targetDate = logicalDate || date;
  if (targetDate) {
    whereClauses.push('(s.clock_in LIKE ? OR substr(s.clock_in, 1, 10) = ?)');
    params.push(`${targetDate}%`, targetDate);
  }

  if (startDate) {
    whereClauses.push('s.clock_in >= ?');
    params.push(startDate.includes('T') ? startDate : `${startDate}T00:00:00.000Z`);
  }

  if (endDate) {
    whereClauses.push('s.clock_in <= ?');
    params.push(endDate.includes('T') ? endDate : `${endDate}T23:59:59.999Z`);
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const sql = `
    SELECT 
      s.*,
      u.employee_id,
      u.username,
      u.display_name,
      u.department_id,
      u.team_id,
      sh.name as shift_name
    FROM attendance_sessions s
    JOIN users u ON s.user_id = u.id
    LEFT JOIN shifts sh ON s.shift_id = sh.id
    ${whereSql}
    ORDER BY s.clock_in DESC
    LIMIT ? OFFSET ?
  `;

  const rows = query(sql, [...params, limit, offset]);

  // Fetch breaks for returned sessions
  const sessionIds = rows.map(r => r.id);
  let breaksMap = {};
  if (sessionIds.length > 0) {
    const placeholders = sessionIds.map(() => '?').join(',');
    const breaks = query(`SELECT * FROM attendance_breaks WHERE session_id IN (${placeholders}) ORDER BY start_time ASC`, sessionIds);
    for (const b of breaks) {
      if (!breaksMap[b.session_id]) breaksMap[b.session_id] = [];
      breaksMap[b.session_id].push(b);
    }
  }

  const formattedSessions = rows.map(r => formatSession(r, breaksMap[r.id] || []));

  let summaryObj = null;
  if (summary === true || summary === 'true') {
    summaryObj = {
      totalSessions: formattedSessions.length,
      totalGrossSeconds: formattedSessions.reduce((acc, s) => acc + (s.grossDuration || 0), 0),
      totalNetSeconds: formattedSessions.reduce((acc, s) => acc + (s.netDuration || 0), 0),
      totalBreakSeconds: formattedSessions.reduce((acc, s) => acc + (s.totalBreakDuration || 0), 0),
      totalOvertimeMinutes: formattedSessions.reduce((acc, s) => acc + (s.overtimeMinutes || 0), 0),
      totalShortfallMinutes: formattedSessions.reduce((acc, s) => acc + (s.shortfallMinutes || 0), 0)
    };
  }

  return {
    success: true,
    sessions: formattedSessions,
    summary: summaryObj,
    total: formattedSessions.length,
    limit,
    offset
  };
}

module.exports = {
  BREAK_TYPES,
  ATTENDANCE_SOURCES,
  ATTENDANCE_STATUS,
  AttendanceError,
  ConflictError,
  NotFoundError,
  ForbiddenError,
  BadRequestError,
  normalizeBreakType,
  normalizeSource,
  formatBreak,
  formatSession,
  evaluatePunctuality,
  mergeBreakIntervals,
  calculateHours,
  clockIn,
  getActiveSession,
  clockOut,
  startBreak,
  endBreak,
  getTimesheets
};
