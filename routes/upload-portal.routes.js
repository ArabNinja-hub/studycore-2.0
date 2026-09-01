// =============================================
// STUDYCORE — Code-gated upload portal (routes/upload-portal.routes.js)
// -----------------------------------------------
// A second, deliberately minimal admin surface: ONE access code unlocks a
// page that can do exactly one thing — upload resources. No analytics, no
// student list, no payments, no program management, no delete. It exists so
// content can be added quickly (or by a trusted helper) without handing over
// the full admin dashboard.
//
// How access works:
//   POST /api/upload-portal/unlock  { code }  -> sets a short-lived signed
//   cookie (sc_upload) whose payload is { scope: 'upload-portal' }. Every
//   other endpoint here requires that cookie (or a real logged-in ADMIN
//   session, so the owner never has to type the code twice).
//
// The code itself is NEVER sent to the browser and is compared in constant
// time; unlock attempts are rate limited by server.js.
// =============================================

const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { upload } = require('../middleware/upload');
const { attachUser } = require('../middleware/auth');
const { createResource, serializeResource } = require('../lib/resource-intake');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'studycore-dev-secret-change-me';
const UPLOAD_COOKIE = 'sc_upload';
const SESSION_HOURS = Number(process.env.UPLOAD_PORTAL_HOURS || 12);
// The access code. Overridable via .env so it can be rotated without a code
// change; the documented default is the one the owner asked for.
const ACCESS_CODE = process.env.UPLOAD_PORTAL_CODE || 'Studycore2026#';

function codeMatches(supplied) {
  const a = Buffer.from(String(supplied || ''), 'utf8');
  const b = Buffer.from(ACCESS_CODE, 'utf8');
  if (a.length !== b.length) return false; // timingSafeEqual requires equal lengths
  return crypto.timingSafeEqual(a, b);
}

function issueUploadCookie(res) {
  const token = jwt.sign({ scope: 'upload-portal' }, JWT_SECRET, { expiresIn: `${SESSION_HOURS}h` });
  res.cookie(UPLOAD_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_HOURS * 60 * 60 * 1000
  });
}

function hasUploadCookie(req) {
  const token = req.cookies && req.cookies[UPLOAD_COOKIE];
  if (!token) return false;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return payload && payload.scope === 'upload-portal';
  } catch {
    return false;
  }
}

// Unlocked = valid code cookie, OR an already logged-in ADMIN.
function requireUploadAccess(req, res, next) {
  if (hasUploadCookie(req)) return next();
  attachUser(req, res, () => {
    if (req.user && req.user.role === 'ADMIN') return next();
    return res.status(401).json({ message: 'Enter the access code to use the upload portal.', locked: true });
  });
}

// Whose id lands in resources.uploaded_by: the logged-in admin when there is
// one, otherwise the platform's admin account (the code holder is acting on
// the owner's behalf).
function uploaderId(req) {
  if (req.user && req.user.role === 'ADMIN') return req.user.id;
  const admin = db.prepare("SELECT id FROM users WHERE role = 'ADMIN' ORDER BY created_at ASC LIMIT 1").get();
  return admin ? admin.id : null;
}

// ---- Session -------------------------------------------------------------

router.post('/unlock', (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ message: 'Please enter the access code.' });
  if (!codeMatches(code)) return res.status(401).json({ message: 'That access code is not correct.' });
  issueUploadCookie(res);
  res.json({ unlocked: true, expiresInHours: SESSION_HOURS });
});

router.get('/session', (req, res) => {
  if (hasUploadCookie(req)) return res.json({ unlocked: true, via: 'code' });
  attachUser(req, res, () => {
    if (req.user && req.user.role === 'ADMIN') return res.json({ unlocked: true, via: 'admin' });
    res.json({ unlocked: false });
  });
});

router.post('/lock', (req, res) => {
  res.clearCookie(UPLOAD_COOKIE);
  res.json({ locked: true });
});

// Everything below needs an unlocked portal.
router.use(requireUploadAccess);

// ---- Form data (programs, courses, topics, upload limit) -----------------

router.get('/form-options', (req, res) => {
  const programs = db.prepare('SELECT code, name, short_name FROM programs ORDER BY rowid ASC').all().map((p) => ({
    code: p.code,
    name: p.name,
    shortName: p.short_name || p.name
  }));

  const courses = db.prepare(`
    SELECT c.id, c.code, c.name,
           (SELECT GROUP_CONCAT(pc.program_code) FROM program_courses pc WHERE pc.course_id = c.id) AS program_codes
    FROM courses c
    ORDER BY c.code ASC
  `).all().map((c) => ({
    id: c.id,
    code: c.code,
    name: c.name,
    programs: c.program_codes ? c.program_codes.split(',') : []
  }));

  const topics = db.prepare(
    "SELECT DISTINCT topic FROM resources WHERE topic IS NOT NULL AND topic != '' ORDER BY topic ASC"
  ).all().map((r) => r.topic);

  res.json({
    programs,
    courses,
    topics,
    maxUploadMB: Number(process.env.MAX_UPLOAD_MB || 2000)
  });
});

// ---- The one action this portal has: create a resource -------------------

router.post('/resources', upload.single('file'), (req, res) => {
  const { status, body } = createResource({
    body: req.body,
    file: req.file,
    uploaderId: uploaderId(req)
  });
  res.status(status).json(body);
});

// A short "just uploaded" list so the person at the keyboard can confirm the
// file actually landed. Read-only, newest first, nothing editable.
router.get('/recent', (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM resources
    WHERE category != 'announcement'
    ORDER BY created_at DESC
    LIMIT 10
  `).all();
  res.json({ resources: rows.map(serializeResource) });
});

module.exports = router;
module.exports.UPLOAD_COOKIE = UPLOAD_COOKIE;
