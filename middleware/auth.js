const jwt = require('jsonwebtoken');
const db = require('../db');
const {
  normalizeRole,
  dashboardPathForRole
} = require('../lib/roles');

// There is deliberately NO fallback secret. A deployment that boots without
// JWT_SECRET (or with a weak one) must fail loudly at startup instead of
// signing tokens with a value every attacker knows from the repository.
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error(
    'FATAL: JWT_SECRET must be set and contain at least 32 characters.'
  );
}

// Issuer/audience pin tokens to StudyCore (issuer) and to the web app
// (audience), so a token cannot be replayed against a different service
// that happens to share the same secret.
const JWT_ISSUER = 'studycore';
const JWT_AUDIENCE = 'studycore-web';
const COOKIE_NAME = 'sc_token';

// The session lifetime is unchanged (7 days) - these hardening changes do
// not shorten or extend existing sessions beyond that.
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/',
  maxAge: 7 * 24 * 60 * 60 * 1000
};

function createToken(user) {
  return jwt.sign({
    id: user.id,
    email: user.email,
    // A token is only a convenience; every protected request re-reads this
    // role from SQLite below. Keeping the claim canonical avoids old uppercase
    // values leaking back to the browser during a rolling upgrade.
    role: normalizeRole(user.role) || 'student'
  }, JWT_SECRET, {
    expiresIn: '7d',
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE
  });
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, COOKIE_OPTIONS);
}

// Clearing with the SAME attributes as setAuthCookie matters: a Set-Cookie
// only overwrites an earlier cookie when the path/domain/samesite match,
// so a bare clearCookie() could leave the original session cookie alive.
function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/'
  });
}

// Single verification path for every consumer (attachUser, requireAuth,
// requirePageAuth) so the issuer/audience rules cannot drift between them.
//
// Migration note: sessions issued before the issuer/audience claims were
// introduced carry no such claims. Rather than force an application-wide
// logout, those legacy tokens (signed with the same secret, expiring
// naturally within 7 days) are still accepted; every newly issued token
// carries both claims and any token whose claims do not match is rejected.
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE
    });
  } catch (err) {
    const isClaimError = err && err.name === 'JsonWebTokenError' &&
      /issuer|audience/i.test(String(err.message));
    if (!isClaimError) return null;
    try {
      const legacyPayload = jwt.verify(token, JWT_SECRET);
      // Only true legacy sessions (no issuer/audience claims at all) pass.
      // A token with mismatched claims fails the strict check above and is
      // also rejected here.
      if (legacyPayload.iss !== undefined || legacyPayload.aud !== undefined) return null;
      return legacyPayload;
    } catch {
      return null;
    }
  }
}

function getTokenFromRequest(req) {
  if (req.cookies && req.cookies[COOKIE_NAME]) return req.cookies[COOKIE_NAME];
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  return null;
}

function freshSessionUser(id) {
  return db.prepare('SELECT id, email, role, is_active, program_code FROM users WHERE id = ?').get(id);
}

function isActive(user) {
  return Boolean(user) && Number(user.is_active) !== 0;
}

function attachFreshUser(payload, freshUser) {
  return {
    ...payload,
    email: freshUser.email || payload.email,
    role: normalizeRole(freshUser.role) || 'student',
    // Quiz and other visibility checks need the current program, too. Never
    // preserve a missing/stale program claim from the signed session payload.
    program_code: freshUser.program_code || null
  };
}

// Populates req.user if a valid, active token is present, but never blocks the
// request. A disabled/deleted account is deliberately treated as logged out
// here so public pages do not keep presenting an old session as usable.
function attachUser(req, res, next) {
  const token = getTokenFromRequest(req);
  if (token) {
    const payload = verifyToken(token);
    if (payload) {
      const freshUser = freshSessionUser(payload.id);
      if (isActive(freshUser)) {
        req.user = attachFreshUser(payload, freshUser);
      } else {
        req.user = null;
        clearAuthCookie(res);
      }
    } else {
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
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ message: 'Your session has expired. Please log in again.' });
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
    const payload = verifyToken(token);
    if (!payload) return res.redirect('/login.html');
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
  };
}

module.exports = {
  createToken,
  setAuthCookie,
  clearAuthCookie,
  verifyToken,
  attachUser,
  requireAuth,
  requireRole,
  requirePageAuth,
  COOKIE_NAME
};
