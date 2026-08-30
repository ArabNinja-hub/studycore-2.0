require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const multer = require('multer');

require('./db'); // initializes the database and seeds the admin account

const { requirePageAuth, attachUser } = require('./middleware/auth');
const { securityHeaders, rateLimit } = require('./middleware/security');
const authRoutes = require('./routes/auth.routes');
const resourceRoutes = require('./routes/resources.routes');
const coursesRoutes = require('./routes/courses.routes');
const adminRoutes = require('./routes/admin.routes');
const notificationRoutes = require('./routes/notifications.routes');
const communityRoutes = require('./routes/community.routes');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(securityHeaders);

// Brute-force protection: 20 attempts per minute per IP is generous for a
// real user who mistypes a password, but stops automated credential guessing.
const authRateLimit = rateLimit({ windowMs: 60 * 1000, max: 20 });

// ---- API routes -----------------------------------------------------------
app.use('/api/auth/login', authRateLimit);
app.use('/api/auth/register', authRateLimit);
// Password change is equally worth brute-force protection (the current
// password is still verified server-side; this just stops credential
// guessing by IP).
app.use('/api/auth/password', authRateLimit);
app.use('/api/auth', authRoutes);

// Public site config. Official WhatsApp links live in .env so the owner can
// rotate them without touching page code; the community panels on every page
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
app.use('/api/admin', adminRoutes);
app.use('/api/notifications', notificationRoutes);

// The on-site student community: one shared group room (/pages/community.html)
// where students ask questions and the admin answers. Session-gated like every
// other /api route; the room itself is moderated server-side.
app.use('/api/community', communityRoutes);

// ---- Protected view routes (server-side gated, must be registered BEFORE
// the static file middleware so an unauthenticated request can never receive
// admin.html or dashboard.html directly) -----------------------------------
app.get(['/admin', '/admin.html'], requirePageAuth('ADMIN'), (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

app.get(['/dashboard', '/dashboard.html'], requirePageAuth('STUDENT'), (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

// Internal document viewer. Any logged-in user may open the page itself; the
// document metadata and bytes are fetched afterwards from the existing
// session-gated /api/resources/:id and /:id/stream endpoints, which enforce
// the real access rules (Premium vs. trial, per-resource is_premium, etc.).
// Registering this route BEFORE the static middleware means an unauthenticated
// request is redirected to /login.html rather than ever receiving the viewer.
app.get('/viewer/:documentId', requirePageAuth(), (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'views', 'viewer.html'));
});

// Logged-in users shouldn't see the marketing login/signup pages again -
// bounce them straight to their dashboard.
app.get(['/login.html', '/signup.html'], (req, res, next) => {
  attachUser(req, res, () => {
    if (!req.user) return next();
    return res.redirect(req.user.role === 'ADMIN' ? '/admin.html' : '/dashboard.html');
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
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ message: `File is too large. Max allowed size is ${process.env.MAX_UPLOAD_MB || 2000}MB.` });
    }
    return res.status(400).json({ message: err.message });
  }
  if (err) {
    console.error(err);
    return res.status(400).json({ message: err.message || 'Something went wrong.' });
  }
  next();
});

app.listen(PORT, () => {
  console.log(`StudyCore server running on http://localhost:${PORT}`);
});
