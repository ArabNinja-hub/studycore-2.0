const jwt = require('jsonwebtoken');
const db = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'studycore-dev-secret-change-me';
const COOKIE_NAME = 'sc_token';

function createToken(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
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

// Populates req.user if a valid token is present, but never blocks the request.
function attachUser(req, res, next) {
  const token = getTokenFromRequest(req);
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const freshUser = db.prepare('SELECT id, role FROM users WHERE id = ?').get(payload.id);
      if (freshUser) {
        req.user = { ...payload, role: freshUser.role };
      } else {
        // Token is validly signed but points at a user that no longer
        // exists (e.g. the database was reset). Treat as logged out and
        // clear the stale cookie so the browser stops sending it - without
        // this, a page like /login.html that redirects "logged in" users
        // away can loop forever against a page that redirects "logged out"
        // users back.
        req.user = null;
        clearAuthCookie(res);
      }
    } catch {
      req.user = null;
    }
  }
  next();
}

// Blocks the request unless a valid token is present.
function requireAuth(req, res, next) {
  const token = getTokenFromRequest(req);
  if (!token) return res.status(401).json({ message: 'Please log in to continue.' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    const freshUser = db.prepare('SELECT id, role FROM users WHERE id = ?').get(req.user.id);
    if (!freshUser) return res.status(401).json({ message: 'Account no longer exists.' });
    req.user.role = freshUser.role; // always trust the DB role, never the token alone
    next();
  } catch {
    return res.status(401).json({ message: 'Your session has expired. Please log in again.' });
  }
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      return res.status(403).json({ message: 'You do not have permission to perform this action.' });
    }
    next();
  };
}

// For protecting full HTML page routes server-side (redirects instead of JSON errors).
function requirePageAuth(role) {
  return (req, res, next) => {
    const token = getTokenFromRequest(req);
    if (!token) return res.redirect('/login.html');
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const freshUser = db.prepare('SELECT id, role FROM users WHERE id = ?').get(payload.id);
      if (!freshUser) return res.redirect('/login.html');
      if (role && freshUser.role !== role) {
        return res.redirect(freshUser.role === 'ADMIN' ? '/admin.html' : '/dashboard.html');
      }
      req.user = { ...payload, role: freshUser.role };
      next();
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
