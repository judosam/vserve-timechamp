/**
 * 5-Tier Role-Based Access Control (RBAC) & Data Scoping Middleware
 * Pure Node.js (Zero external dependencies)
 */

const ROLES = Object.freeze({
  SUPER_ADMIN: 'SUPER_ADMIN',
  HR_ADMIN: 'HR_ADMIN',
  MANAGER: 'MANAGER',
  TEAM_LEADER: 'TEAM_LEADER',
  EMPLOYEE: 'EMPLOYEE'
});

const ROLE_HIERARCHY = Object.freeze({
  SUPER_ADMIN: 5,
  HR_ADMIN: 4,
  MANAGER: 3,
  TEAM_LEADER: 2,
  EMPLOYEE: 1
});

/**
 * Gates an endpoint by allowed roles.
 * Returns HTTP 403 Forbidden ({ success: false, error: 'Forbidden' })
 * if user role is not permitted.
 * Note: SUPER_ADMIN possesses unrestricted access across all gated endpoints.
 * 
 * @param {string[]|string} allowedRoles
 * @returns {Function} (req, res, next) => boolean
 */
function requireRole(allowedRoles) {
  const roles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];

  return function (req, res, next) {
    if (!req.user) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
      if (typeof next === 'function') next(new Error('Unauthorized'));
      return false;
    }

    const userRole = req.user.role;
    const isAuthorized = roles.includes(userRole) || userRole === ROLES.SUPER_ADMIN;

    if (!isAuthorized) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Forbidden' }));
      if (typeof next === 'function') next(new Error('Forbidden'));
      return false;
    }

    if (typeof next === 'function') next();
    return true;
  };
}

/**
 * Produces parameterized SQL WHERE clauses to enforce data isolation.
 * 
 * @param {Object} user req.user
 * @param {string} entityType 'attendance' | 'breaks' | 'employees' | 'users' | 'leaves' | 'corrections' | 'reports' | 'telemetry'
 * @param {string} [tableAlias] e.g. 'a', 'u', 'l'
 * @returns {{ whereClause: string, params: any[] }}
 */
function scopeQuery(user, entityType, tableAlias = '') {
  const prefix = tableAlias ? `${tableAlias}.` : '';

  if (!user) {
    return { whereClause: '1 = 0', params: [] };
  }

  switch (user.role) {
    case ROLES.SUPER_ADMIN:
    case ROLES.HR_ADMIN:
      // Global organization-wide data access
      return { whereClause: '1 = 1', params: [] };

    case ROLES.MANAGER:
      // Department-scoped access
      if (entityType === 'employees' || entityType === 'users') {
        return {
          whereClause: `${prefix}department_id = ?`,
          params: [user.departmentId]
        };
      }
      return {
        whereClause: `${prefix}user_id IN (SELECT id FROM users WHERE department_id = ?)`,
        params: [user.departmentId]
      };

    case ROLES.TEAM_LEADER:
      // Team-scoped access
      if (entityType === 'employees' || entityType === 'users') {
        return {
          whereClause: `${prefix}team_id = ?`,
          params: [user.teamId]
        };
      }
      return {
        whereClause: `${prefix}user_id IN (SELECT id FROM users WHERE team_id = ?)`,
        params: [user.teamId]
      };

    case ROLES.EMPLOYEE:
    default:
      // Self-scoped access
      if (entityType === 'employees' || entityType === 'users') {
        return {
          whereClause: `${prefix}id = ?`,
          params: [user.id]
        };
      }
      return {
        whereClause: `${prefix}user_id = ?`,
        params: [user.id]
      };
  }
}

/**
 * Validates whether currentUser has authority over targetUser.
 * @param {Object} currentUser req.user
 * @param {Object} targetUser target user entity
 * @returns {boolean}
 */
function canAccessUser(currentUser, targetUser) {
  if (!currentUser || !targetUser) return false;
  if (currentUser.role === ROLES.SUPER_ADMIN) return true;
  if (currentUser.role === ROLES.HR_ADMIN) {
    return targetUser.role !== ROLES.SUPER_ADMIN;
  }
  if (currentUser.role === ROLES.MANAGER) {
    return currentUser.departmentId &&
           currentUser.departmentId === (targetUser.department_id || targetUser.departmentId) &&
           targetUser.role !== ROLES.SUPER_ADMIN &&
           targetUser.role !== ROLES.HR_ADMIN;
  }
  if (currentUser.role === ROLES.TEAM_LEADER) {
    return currentUser.teamId &&
           currentUser.teamId === (targetUser.team_id || targetUser.teamId) &&
           targetUser.role === ROLES.EMPLOYEE;
  }
  if (currentUser.role === ROLES.EMPLOYEE) {
    return currentUser.id === targetUser.id;
  }
  return false;
}

module.exports = {
  ROLES,
  ROLE_HIERARCHY,
  requireRole,
  scopeQuery,
  canAccessUser
};
