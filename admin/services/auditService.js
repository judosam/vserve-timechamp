/**
 * VserveTimeChamp Audit Logging Service
 * Provides immutable, structured audit logging of security and administrative events.
 * Pure Node.js (Zero external dependencies)
 */

const crypto = require('crypto');
const { getDb } = require('../db/index');

const AUDIT_ACTIONS = Object.freeze({
  // Authentication
  AUTH_LOGIN_SUCCESS: 'AUTH_LOGIN_SUCCESS',
  AUTH_LOGIN_FAILURE: 'AUTH_LOGIN_FAILURE',
  AUTH_LOGOUT: 'AUTH_LOGOUT',
  AUTH_PASSWORD_CHANGE: 'AUTH_PASSWORD_CHANGE',
  AUTH_SESSION_REVOKED: 'AUTH_SESSION_REVOKED',

  // User Management
  USER_CREATE: 'USER_CREATE',
  USER_UPDATE: 'USER_UPDATE',
  USER_DELETE: 'USER_DELETE',
  USER_ROLE_CHANGE: 'USER_ROLE_CHANGE',
  USER_STATUS_CHANGE: 'USER_STATUS_CHANGE',
  USER_BULK_IMPORT: 'USER_BULK_IMPORT',

  // Shifts & Rostering
  SHIFT_CREATE: 'SHIFT_CREATE',
  SHIFT_UPDATE: 'SHIFT_UPDATE',
  SHIFT_DELETE: 'SHIFT_DELETE',
  SHIFT_ASSIGN: 'SHIFT_ASSIGN',

  // Leaves & Corrections
  LEAVE_SUBMIT: 'LEAVE_SUBMIT',
  LEAVE_APPROVE: 'LEAVE_APPROVE',
  LEAVE_REJECT: 'LEAVE_REJECT',
  CORRECTION_SUBMIT: 'CORRECTION_SUBMIT',
  CORRECTION_APPROVE: 'CORRECTION_APPROVE',
  CORRECTION_REJECT: 'CORRECTION_REJECT',

  // System Configuration & Policies
  CONFIG_UPDATE: 'CONFIG_UPDATE',
  SECURITY_POLICY_UPDATE: 'SECURITY_POLICY_UPDATE',
  SEED_INITIALIZATION: 'SEED_INITIALIZATION'
});

/**
 * Extracts remote client IP address from HTTP request headers or socket.
 * @param {import('http').IncomingMessage} req
 * @returns {string} Client IP address
 */
function getClientIp(req) {
  if (!req) return '127.0.0.1';
  const forwarded = req.headers?.['x-forwarded-for'];
  if (forwarded) {
    return String(forwarded).split(',')[0].trim();
  }
  const realIp = req.headers?.['x-real-ip'];
  if (realIp) return String(realIp).trim();
  return req.socket?.remoteAddress || '127.0.0.1';
}

/**
 * Factory for Audit Logging Service bound to an SQLite database.
 * @param {import('node:sqlite').DatabaseSync} [customDb] - Optional custom DatabaseSync instance
 */
function createAuditService(customDb = null) {
  function resolveDb() {
    return customDb || getDb();
  }

  /**
   * Logs a structured audit event.
   * Automatically sanitizes credentials and inserts immutably into audit_logs.
   * 
   * @param {Object} event
   * @param {import('http').IncomingMessage} [event.req] HTTP request
   * @param {string} event.action Event action (AUDIT_ACTIONS)
   * @param {string} event.targetEntity Table/entity name ('users', 'config', 'auth', etc.)
   * @param {string} [event.targetId] Primary ID of affected entity
   * @param {Object} [event.details] Metadata object
   * @param {string} [event.userId] Actor user ID (defaults to req.user.id)
   * @param {string} [event.ipAddress] Explicit IP override
   * @returns {Object} Created audit record
   */
  function logAuditEvent({
    req,
    action,
    targetEntity,
    targetId = null,
    details = {},
    userId = null,
    ipAddress = null
  }) {
    const db = resolveDb();
    const id = `aud_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    const timestamp = new Date().toISOString();
    const resolvedUserId = userId || req?.user?.id || null;
    const resolvedIp = ipAddress || getClientIp(req);

    // Sanitize sensitive credential data
    const sanitizedDetails = { ...details };
    delete sanitizedDetails.password;
    delete sanitizedDetails.password_hash;
    delete sanitizedDetails.salt;
    delete sanitizedDetails.token;

    if (req) {
      if (req.headers?.['user-agent'] && !sanitizedDetails.userAgent) {
        sanitizedDetails.userAgent = req.headers['user-agent'];
      }
      if (req.user?.username && !sanitizedDetails.actorUsername) {
        sanitizedDetails.actorUsername = req.user.username;
      }
    }

    const detailsJson = JSON.stringify(sanitizedDetails);

    const stmt = db.prepare(`
      INSERT INTO audit_logs (
        id, timestamp, user_id, action, target_entity, target_id, details_json, ip_address
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      timestamp,
      resolvedUserId,
      action,
      targetEntity,
      targetId ? String(targetId) : null,
      detailsJson,
      resolvedIp
    );

    return {
      id,
      timestamp,
      userId: resolvedUserId,
      action,
      targetEntity,
      targetId,
      details: sanitizedDetails,
      ipAddress: resolvedIp
    };
  }

  /**
   * Retrieves audit logs with role-based scoping and filtering.
   * Restricted to SUPER_ADMIN and HR_ADMIN.
   * 
   * @param {Object} options
   * @param {Object} options.currentUser req.user
   * @param {string} [options.action]
   * @param {string} [options.targetEntity]
   * @param {string} [options.userId]
   * @param {string} [options.startDate]
   * @param {string} [options.endDate]
   * @param {number} [options.limit=50]
   * @param {number} [options.offset=0]
   * @returns {{ logs: Array, total: number }}
   */
  function getAuditLogs({
    currentUser,
    action,
    targetEntity,
    userId,
    startDate,
    endDate,
    limit = 50,
    offset = 0
  }) {
    const db = resolveDb();
    const conditions = ['1 = 1'];
    const params = [];

    // Role-based scoping
    if (currentUser?.role === 'HR_ADMIN') {
      // HR Admin restricted to employee lifecycle events
      conditions.push(`target_entity IN ('users', 'employees', 'leaves', 'attendance', 'shifts')`);
    } else if (currentUser?.role !== 'SUPER_ADMIN') {
      return { logs: [], total: 0 };
    }

    if (action) {
      conditions.push('action = ?');
      params.push(action);
    }
    if (targetEntity) {
      conditions.push('target_entity = ?');
      params.push(targetEntity);
    }
    if (userId) {
      conditions.push('user_id = ?');
      params.push(userId);
    }
    if (startDate) {
      conditions.push('timestamp >= ?');
      params.push(startDate);
    }
    if (endDate) {
      conditions.push('timestamp <= ?');
      params.push(endDate);
    }

    const whereSql = conditions.join(' AND ');

    const countStmt = db.prepare(`SELECT COUNT(*) as count FROM audit_logs WHERE ${whereSql}`);
    const totalRow = countStmt.get(...params);
    const total = totalRow ? totalRow.count : 0;

    const selectStmt = db.prepare(`
      SELECT id, timestamp, user_id, action, target_entity, target_id, details_json, ip_address
      FROM audit_logs
      WHERE ${whereSql}
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `);

    const rows = selectStmt.all(...params, limit, offset);
    const logs = rows.map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      userId: r.user_id,
      action: r.action,
      targetEntity: r.target_entity,
      targetId: r.target_id,
      details: r.details_json ? JSON.parse(r.details_json) : {},
      ipAddress: r.ip_address
    }));

    return { logs, total };
  }

  return {
    logAuditEvent,
    getAuditLogs
  };
}

// Default instance using standard db connection
const defaultAuditService = createAuditService();

module.exports = {
  AUDIT_ACTIONS,
  getClientIp,
  createAuditService,
  logAuditEvent: defaultAuditService.logAuditEvent,
  getAuditLogs: defaultAuditService.getAuditLogs
};
