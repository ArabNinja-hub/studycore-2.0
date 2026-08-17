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
app.use('/api/auth', authRoutes);
app.use('/api/resources', resourceRoutes);
app.use('/api/courses', coursesRoutes);
app.use('/api/admin', adminRoutes);

// ---- Protected view routes (server-side gated, must be registered BEFORE
// the static file middleware so an unauthenticated request can never receive
// admin.html or dashboard.html directly) -----------------------------------
app.get(['/admin', '/admin.html'], requirePageAuth('ADMIN'), (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

app.get(['/dashboard', '/dashboard.html'], requirePageAuth('STUDENT'), (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
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
  etag: true
}));

app.get('*', (req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
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
