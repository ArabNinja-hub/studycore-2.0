const jwt = require('jsonwebtoken');
const db = require('../db');
const {
  normalizeRole,
  dashboardPathForRole
} = require('../lib/roles');

const JWT_SECRET = process.env.JWT_SECRET || 'studycore-dev-secret-change-me';
const COOKIE_NAME = 'sc_token';

function createToken(user) {
  return jwt.sign({
    id: user.id,
    email: user.email,
    // A token is only a convenience; every protected request re-reads this
    // role from SQLite below. Keeping the claim canonical avoids old uppercase
    // values leaking back to the browser during a rolling upgrade.
    role: normalizeRole(user.role) || 'student'
  }, JWT_SECRET, { expiresIn: '7d' });
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

function getTokenFromRequest(req) {
  if (req.cookies && req.cookies[COOKIE_NAME]) return req.cookies[COOKIE_NAME];
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  return null;
}

function freshSessionUser(id) {
  return db.prepare('SELECT id, email, role, is_active FROM users WHERE id = ?').get(id);
}

function isActive(user) {
  return Boolean(user) && Number(user.is_active) !== 0;
}

function attachFreshUser(payload, freshUser) {
  return {
    ...payload,
    email: freshUser.email || payload.email,
    role: normalizeRole(freshUser.role) || 'student'
  };
}

// Populates req.user if a valid, active token is present, but never blocks the
// request. A disabled/deleted account is deliberately treated as logged out
// here so public pages do not keep presenting an old session as usable.
function attachUser(req, res, next) {
  const token = getTokenFromRequest(req);
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const freshUser = freshSessionUser(payload.id);
      if (isActive(freshUser)) {
        req.user = attachFreshUser(payload, freshUser);
      } else {
        req.user = null;
        clearAuthCookie(res);
      }
    } catch {
      req.user = null;
    }
  }
  next();
}

// Blocks the request unless a valid token belongs to a current, active user.
// Role and account state always come from the database, never from the JWT.
function requireAuth(req, res, next) {
  const token = getTokenFromRequest(req);
  if (!token) return res.status(401).json({ message: 'Please log in to continue.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const freshUser = freshSessionUser(payload.id);
    if (!freshUser) {
      clearAuthCookie(res);
      return res.status(401).json({ message: 'Account no longer exists.' });
    }
    if (!isActive(freshUser)) {
      clearAuthCookie(res);
      return res.status(403).json({ message: 'This account has been disabled. Please contact StudyCore support.' });
    }
    req.user = attachFreshUser(payload, freshUser);
    return next();
  } catch {
    return res.status(401).json({ message: 'Your session has expired. Please log in again.' });
  }
}

// Accepts one role, multiple roles, or an array. The comparison normalizes
// legacy values such as ADMIN/STUDENT, while all new application roles are
// persisted as lower-case admin, content_admin and student.
function requireRole(...requestedRoles) {
  const flattened = requestedRoles.flat();
  const allowed = new Set(flattened.map(normalizeRole).filter(Boolean));
  return (req, res, next) => {
    const actual = req.user && normalizeRole(req.user.role);
    if (!actual || !allowed.has(actual)) {
      return res.status(403).json({ message: 'You do not have permission to perform this action.' });
    }
    return next();
  };
}

// For protecting full HTML page routes server-side (redirects instead of JSON
// errors). A Content Admin who hand-types a Main Admin URL is sent back to the
// Content Admin dashboard; the protected API routes independently reject it.
function requirePageAuth(...requestedRoles) {
  const flattened = requestedRoles.flat().filter((role) => role !== undefined && role !== null);
  const allowed = flattened.length ? new Set(flattened.map(normalizeRole).filter(Boolean)) : null;
  return (req, res, next) => {
    const token = getTokenFromRequest(req);
    if (!token) return res.redirect('/login.html');
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const freshUser = freshSessionUser(payload.id);
      if (!freshUser || !isActive(freshUser)) {
        clearAuthCookie(res);
        return res.redirect('/login.html?disabled=1');
      }
      const role = normalizeRole(freshUser.role);
      if (!role) {
        clearAuthCookie(res);
        return res.redirect('/login.html');
      }
      if (allowed && !allowed.has(role)) {
        return res.redirect(dashboardPathForRole(role));
      }
      req.user = attachFreshUser(payload, freshUser);
      return next();
    } catch {
      return res.redirect('/login.html');
    }
  };
}

module.exports = {
  createToken,
  setAuthCookie,
  clearAuthCookie,
  attachUser,
  requireAuth,
  requireRole,
  requirePageAuth,
  COOKIE_NAME
};
