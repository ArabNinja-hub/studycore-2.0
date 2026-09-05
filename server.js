require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const multer = require('multer');

require('./db'); // initializes the database and seeds the admin account

const { requirePageAuth, attachUser } = require('./middleware/auth');
const { ROLES, dashboardPathForRole, isContentAdmin } = require('./lib/roles');
const { securityHeaders, rateLimit } = require('./middleware/security');
const authRoutes = require('./routes/auth.routes');
const resourceRoutes = require('./routes/resources.routes');
const coursesRoutes = require('./routes/courses.routes');
const programsRoutes = require('./routes/programs.routes');
const adminRoutes = require('./routes/admin.routes');
const contentAdminRoutes = require('./routes/content-admin.routes');
const notificationRoutes = require('./routes/notifications.routes');
const quizRoutes = require('./routes/quiz.routes');

const app = express();
const PORT = process.env.PORT || 3000;

// Stop advertising the framework (X-Powered-By: Express).
app.disable('x-powered-by');

app.set('trust proxy', 1);

// ---- CORS ------------------------------------------------------------------
// The frontend is served SAME-ORIGIN by this process. Browsers still send
// Origin on same-origin POST/PUT/DELETE requests, so allow this request's
// own scheme/host/port as well as explicitly trusted external origins.
// Arbitrary external origins must never receive credentialed CORS access.
const DEFAULT_CORS_ORIGINS = [
  'https://studycore.academy',
  'https://www.studycore.academy'
];
const allowedOrigins = new Set([
  ...DEFAULT_CORS_ORIGINS,
  ...String(process.env.CORS_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)
]);

app.use(cors((req, callback) => {
  const origin = req.get('Origin');
  let sameOrigin = false;
  try {
    // req.protocol honors the trusted TLS-terminating proxy. Use Host rather
    // than req.hostname: preserve the port and do not trust X-Forwarded-Host
    // to turn an unrelated Origin into a same-origin request.
    const requestUrl = new URL(`${req.protocol}://${req.get('Host')}`);
    sameOrigin = ['http:', 'https:'].includes(requestUrl.protocol) && origin === requestUrl.origin;
  } catch { /* malformed host: only an explicit allowlist entry can pass */ }

  if (!origin || sameOrigin || allowedOrigins.has(origin)) {
    return callback(null, { origin: true, credentials: true });
  }
  // Rejected with a 403 in the error handler; never reflect an unknown
  // external origin, even when it supplies forged forwarding headers.
  return callback(new Error('CORS_ORIGIN_NOT_ALLOWED'));
}));

app.use(express.json());
app.use(cookieParser());
app.use(securityHeaders);

// ---------------------------------------------------------------------------
// Rate limiting (per client IP; see middleware/security.js for the
// single-instance vs. multi-instance notes). The existing auth limits are
// kept as-is; the additions below protect the other sensitive
// state-changing endpoints. Deliberately NO global limit - ordinary student
// browsing of public pages must never be throttled.
// ---------------------------------------------------------------------------

// Brute-force protection: 20 attempts per minute per IP is generous for a
// real user who mistypes a password, but stops automated credential guessing.
const authRateLimit = rateLimit({ windowMs: 60 * 1000, max: 20 });

// ---- API routes -----------------------------------------------------------
app.use('/api/auth/login', authRateLimit);
app.use('/api/auth/register', authRateLimit);
// Content Admin creation validates a server-only authorization code, so give
// it a tighter independent limit in addition to the normal auth limiter.
const contentAdminRegistrationLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
app.use(['/api/auth/register-content-admin', '/api/auth/content-admin/register'], authRateLimit, contentAdminRegistrationLimit);
// Password change is equally worth brute-force protection (the current
// password is still verified server-side; this just stops credential
// guessing by IP).
app.use('/api/auth/password', authRateLimit);
// Payment submission: a student makes at most a couple of requests per
// session; 10 per 15 minutes blocks scripted payment spam.
const paymentLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
app.use('/api/auth/subscribe', paymentLimit);
// Profile changes: 20 per hour is plenty for a real user correcting details.
const profileLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 20 });
app.use('/api/auth/profile', profileLimit);
// Uploads are the most expensive request type (large bodies, storage I/O):
// 30 per 15 minutes per IP is generous for a Content Admin publishing a
// batch of notes and hostile to an automated upload flood.
const uploadLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, methods: ['POST', 'PUT', 'PATCH', 'DELETE'] });
app.use(['/api/admin/resources', '/api/content-admin/resources', '/api/quiz/image'], uploadLimit);
// Avatar changes: 10 per hour per IP; displaying a picture is not a change.
const avatarLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, methods: ['POST', 'DELETE'] });
app.use('/api/auth/avatar', avatarLimit);
// Sensitive admin / Content Admin API surfaces: the dashboards make at most
// a handful of calls per interaction, so these limits are wide enough for
// real workflow but stop a compromised session being used at machine speed.
const adminApiLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 300 });
app.use('/api/admin', adminApiLimit);
const contentAdminApiLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 150 });
app.use('/api/content-admin', contentAdminApiLimit);

app.use('/api/auth', authRoutes);

// Public site config. Official WhatsApp links live in .env so the owner can
// rotate them without touching page code; the marketing panels on every page
// fetch them here on load. No auth required - nothing in this payload is
// private.
app.get('/api/config', (req, res) => {
  res.json({
    whatsapp: {
      channel: process.env.WHATSAPP_CHANNEL_URL || 'https://whatsapp.com/channel/0029Vb6sMBVIiRp0rg5RKQ2k',
      group: process.env.WHATSAPP_GROUP_URL || 'https://chat.whatsapp.com/FLRRx5ywcfv76i2Jtjej4i?s=cl&p=a&ilr=4'
    }
  });
});
app.use('/api/resources', resourceRoutes);
app.use('/api/courses', coursesRoutes);
// Multi-program platform: program directory, student program/courses,
// dynamic course home, and admin program/course management.
app.use('/api/programs', programsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/content-admin', contentAdminRoutes);
app.use('/api/notifications', notificationRoutes);
// Quizzes: program-targeted practice for students, authored by Content Admins
// and the Main Admin. The quiz itself is a resource (category='quiz') so it
// inherits the platform's exact program/course visibility rules.
app.use('/api/quiz', quizRoutes);

// ---- Protected view routes (server-side gated, must be registered BEFORE
// the static file middleware so an unauthenticated request can never receive
// admin.html or dashboard.html directly) -----------------------------------
app.get(['/admin', '/admin.html'], requirePageAuth(ROLES.ADMIN), (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

app.get(['/content-admin', '/content-admin.html'], requirePageAuth(ROLES.CONTENT_ADMIN), (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'views', 'content-admin.html'));
});

app.get(['/dashboard', '/dashboard.html'], requirePageAuth(ROLES.STUDENT), (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

// Quizzes: a program-targeted practice surface for students. Main Admin may
// also open it to preview the student experience; authoring happens in the
// dashboards, not here.
app.get(['/quiz', '/quiz.html'], requirePageAuth(ROLES.STUDENT, ROLES.ADMIN), (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'views', 'quiz.html'));
});

// Dynamic course home (program → course). Server-side gated like every other
// authenticated view; the API it calls re-checks program enrollment, so even
// a hand-typed URL never leaks another program's course.
app.get(['/course/:key', '/course.html'], requirePageAuth(ROLES.STUDENT, ROLES.ADMIN), (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'views', 'course.html'));
});

// Internal document viewer. Student and Main Admin sessions may open the page
// itself; the document metadata and bytes are fetched afterwards from the
// session-gated /api/resources/:id and /:id/stream endpoints, which enforce
// the real access rules (Premium vs. trial, per-resource is_premium, etc.).
// Registering this route BEFORE the static middleware means an unauthenticated
// request is redirected to /login.html rather than ever receiving the viewer.
app.get('/viewer/:documentId', requirePageAuth(ROLES.STUDENT, ROLES.ADMIN), (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'views', 'viewer.html'));
});

// These pages are publicly viewable marketing/student-library shells, so they
// must remain available to visitors and students. An authenticated Content
// Admin is nevertheless sent to their dedicated workspace before the static
// file is served. This complements (rather than replaces) the API-level role
// checks that deny the underlying student library, community, and course data.
const contentAdminStudentPagePaths = [
  '/pages/announcements.html',
  '/pages/courses.html',
  '/pages/lesson.html',
  '/pages/resources.html',
  '/pages/search.html',
  '/pages/videos.html',
  '/pages/subjects/biology.html',
  '/pages/subjects/chemistry.html',
  '/pages/subjects/communication.html',
  '/pages/subjects/mathematics.html',
  '/pages/subjects/physics.html',
  '/pages/subjects/programming.html'
];
app.get(contentAdminStudentPagePaths, (req, res, next) => {
  attachUser(req, res, () => {
    if (!isContentAdmin(req.user)) return next();
    res.set('Cache-Control', 'no-store');
    return res.redirect('/content-admin.html');
  });
});

// Logged-in users shouldn't see the marketing login/signup pages again -
// bounce them straight to their dashboard.
app.get(['/login.html', '/signup.html', '/content-admin-signup.html'], (req, res, next) => {
  attachUser(req, res, () => {
    if (!req.user) return next();
    return res.redirect(dashboardPathForRole(req.user.role));
  });
});

// ---- Static assets (marketing pages, css, js, images, student content
// pages). This is the ONLY directory served as-is - server.js, routes/,
// db/, and .env are never reachable over HTTP. Uploaded files live in
// Cloudflare R2 (see lib/r2.js), not on this server's disk at all. --------
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
  etag: true,
  setHeaders(res, filePath) {
    // HTML, JS and CSS are the live surface of the site and change on most
    // deploys. Caching them for a full day means a browser or CDN can keep
    // serving a stale copy after a deploy — which is exactly how a page ended
    // up calling a shared renderer (lessonRowHtml) that had been moved into
    // main.js, while the visitor's cached main.js no longer defined it.
    // Force these to revalidate (via ETag) on every request; images and
    // vendored libraries keep the longer maxAge below.
    if (/\.(html|js|css)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    }
  }
}));

// Anything that did not match a real page, asset, or API route gets a real
// 404 (a proper page, not a silent redirect to the homepage) - so dead or
// mistyped URLs are honest, and search engines do not treat typos as
// duplicates of the site. Unknown API paths get JSON, not HTML.
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ message: 'Not found.' });
  }
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// ---- Error handling ---------------------------------------------------------
// Internal errors (SQLite, filesystem, R2/AWS, stacks, paths) NEVER reach
// the client: they are logged server-side and the client receives only a
// generic message. Client-facing validation errors are the only errors that
// carry a human message, and they must explicitly opt in by setting
// `statusCode` (4xx) + `message` in our own code (e.g. upload file filters).
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ message: 'File is too large.' });
    }
    return res.status(400).json({ message: 'Invalid upload request.' });
  }

  // Unknown CORS origin (raised in the cors() origin callback above).
  if (err && err.message === 'CORS_ORIGIN_NOT_ALLOWED') {
    return res.status(403).json({ message: 'Origin not allowed by CORS policy.' });
  }

  // Our own validation errors (e.g. rejected file type) set an explicit
  // 4xx statusCode AND a userSafe marker; their messages are written for
  // users, not for logs. Errors from third-party middleware (e.g. the JSON
  // body parser) are never relayed - only their status code is.
  if (err && err.userSafe && Number.isInteger(err.statusCode) && err.statusCode >= 400 && err.statusCode < 500) {
    return res.status(err.statusCode).json({ message: err.message });
  }

  // Malformed request body from the JSON body parser: generic 400 (or 413
  // when the payload exceeds the size limit), never the parser's own
  // error text.
  if (err && err.type && String(err.type).startsWith('entity.')) {
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ message: 'Request body is too large.' });
    }
    return res.status(400).json({ message: 'Invalid request body.' });
  }

  // Everything else: log the full error server-side, answer generically.
  if (err) {
    console.error(err);
    if (res.headersSent) return next(err);
    return res.status(500).json({ message: 'Something went wrong. Please try again.' });
  }
  next();
});

// Last-resort logging for background promises. HTTP async handlers use
// lib/async-handler.js so their errors reach the middleware above and return
// an actual response; this process-level listener cannot finish a request.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

// Exporting the configured app keeps the production server unchanged while
// allowing integration tests to exercise the exact same routes and page gates
// on an ephemeral listener.
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`StudyCore server running on http://0.0.0.0:${PORT}`);
  });
}

module.exports = app;
