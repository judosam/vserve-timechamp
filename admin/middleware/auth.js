/**
 * VserveTimeChamp Authentication Middleware
 * Extracts and validates session tokens, attaching req.user to incoming requests.
 * Pure Node.js (Zero external dependencies)
 */

const { extractToken, validateSession, sanitizeUser } = require('../services/authService');
const { get } = require('../db/index');

/**
 * Factory to create authentication middleware with custom session and user resolution.
 * @param {Object} [options]
 * @param {Function} [options.getSession]
 * @param {Function} [options.getUserById]
 * @returns {Function} authenticate(req, res, next)
 */
function createAuthMiddleware(options = {}) {
  const getSessionFn = options.getSession || validateSession;
  const getUserByIdFn = options.getUserById || (id => get('SELECT * FROM users WHERE id = ?', [id]));

  return function authenticate(req, res, next) {
    const token = extractToken(req);

    if (!token) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
      if (typeof next === 'function') next(new Error('Unauthorized'));
      return null;
    }

    const session = getSessionFn(token);
    if (!session || (session.expiresAt && Date.now() > session.expiresAt)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
      if (typeof next === 'function') next(new Error('Unauthorized'));
      return null;
    }

    // Resolve user from DB or session
    let user = null;
    const userId = session.userId || session.user?.id;
    if (userId) {
      user = getUserByIdFn(userId);
    }
    if (!user) {
      user = session.user;
    }

    if (!user || user.is_active === 0 || user.isActive === false) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
      if (typeof next === 'function') next(new Error('Unauthorized'));
      return null;
    }

    // Standardized user profile attached to req
    req.user = sanitizeUser(user);
    req.token = token;

    if (typeof next === 'function') next();
    return req.user;
  };
}

const defaultAuthenticate = createAuthMiddleware();

module.exports = {
  extractToken,
  createAuthMiddleware,
  authenticate: defaultAuthenticate
};
