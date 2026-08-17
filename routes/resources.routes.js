const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const db = require('../db');
const { requireAuth, attachUser } = require('../middleware/auth');
const { r2, bucketName } = require('../lib/r2');

const router = express.Router();

function serializeResource(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    subject: row.subject,
    course: row.course,
    yearLevel: row.year_level,
    semester: row.semester,
    tags: row.tags ? row.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
    fileName: row.file_name,
    fileSize: row.file_size,
    mimeType: row.mime_type,
    hasFile: Boolean(row.stored_name),
    externalUrl: row.external_url,
    quizData: row.quiz_data ? JSON.parse(row.quiz_data) : null,
    dueDate: row.due_date,
    isPremium: Boolean(row.is_premium),
    publishStatus: row.publish_status,
    downloadCount: row.download_count,
    viewCount: row.view_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// A resource is freely accessible without an active subscription/trial if
// it's an announcement (always has been) or if an admin has explicitly
// flagged it as a free preview (is_premium = 0).
function isFreelyAccessible(row) {
  return row.category === 'announcement' || !row.is_premium;
}

function subscriptionGate(req, res, next) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ message: 'User not found.' });
  const now = Date.now();
  const trialEnd = new Date(user.trial_end || 0).getTime();
  const subEnd = new Date(user.subscription_end || 0).getTime();
  const active = user.role === 'ADMIN' || (user.subscription === 'premium' && now < subEnd);
  const inTrial = user.role !== 'ADMIN' && !active && now < trialEnd;
  req.subscriptionOk = active || inTrial || user.role === 'ADMIN';
  next();
}

// Fetches an object from R2 and pipes it to the response. Honors HTTP Range
// requests (the browser sends these automatically when someone scrubs/seeks
// within a video, or resumes an interrupted download) by forwarding the
// same Range header straight through to R2's GetObjectCommand - without
// this, video playback would still start fine but skipping ahead in the
// player wouldn't work properly.
async function streamR2Object(req, res, key, { disposition, filename, mimeType }) {
  try {
    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: key,
      Range: req.headers.range || undefined
    });
    const object = await r2.send(command);

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', object.ContentType || mimeType || 'application/octet-stream');
    if (object.ContentLength !== undefined) res.setHeader('Content-Length', object.ContentLength);

    const dispositionValue = disposition === 'attachment'
      ? `attachment; filename="${(filename || key).replace(/"/g, '')}"`
      : 'inline';
    res.setHeader('Content-Disposition', dispositionValue);

    if (object.ContentRange) {
      res.status(206);
      res.setHeader('Content-Range', object.ContentRange);
    } else {
      res.status(200);
    }

    object.Body.pipe(res);
    object.Body.on('error', () => { if (!res.headersSent) res.status(500); res.end(); });
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      return res.status(404).json({ message: 'File is missing from storage.' });
    }
    console.error('R2 stream error:', err.message);
    return res.status(502).json({ message: 'Could not reach file storage. Please try again shortly.' });
  }
}

// GET /api/resources?category=&subject=&course=&year=&semester=&search=&sort=&page=&pageSize=
router.get('/', requireAuth, subscriptionGate, (req, res) => {
  const { category, excludeCategory, subject, course, year, semester, search, sort = 'newest', page = 1, pageSize = 24 } = req.query;

  const clauses = [`publish_status = 'published'`];
  const params = {};
  // Without an active subscription/trial, only announcements and resources
  // an admin has explicitly flagged as free previews are visible - rather
  // than blocking the whole request, this narrows the results so a free
  // preview genuinely shows up when browsing.
  if (!req.subscriptionOk) {
    clauses.push(`(category = 'announcement' OR is_premium = 0)`);
  }
  if (category) { clauses.push('category = @category'); params.category = category; }
  if (excludeCategory) { clauses.push('category != @excludeCategory'); params.excludeCategory = excludeCategory; }
  if (subject) { clauses.push('LOWER(subject) = LOWER(@subject)'); params.subject = subject; }
  if (course) { clauses.push('course = @course'); params.course = course; }
  if (year) { clauses.push('year_level = @year'); params.year = year; }
  if (semester) { clauses.push('semester = @semester'); params.semester = semester; }
  if (search) {
    clauses.push('(title LIKE @search OR description LIKE @search OR subject LIKE @search OR tags LIKE @search)');
    params.search = `%${search}%`;
  }

  const sortMap = {
    newest: 'created_at DESC',
    oldest: 'created_at ASC',
    popular: 'download_count DESC',
    title: 'title ASC'
  };
  const orderBy = sortMap[sort] || sortMap.newest;

  const limit = Math.min(Number(pageSize) || 24, 100);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) as count FROM resources ${where}`).get(params).count;
  const rows = db.prepare(`SELECT * FROM resources ${where} ORDER BY ${orderBy} LIMIT ${limit} OFFSET ${offset}`).all(params);

  res.json({ resources: rows.map(serializeResource), total, page: Number(page), pageSize: limit });
});

router.get('/:id/stream', requireAuth, subscriptionGate, async (req, res) => {
  const row = db.prepare(`SELECT * FROM resources WHERE id = ? AND publish_status = 'published'`).get(req.params.id);
  if (!row) return res.status(404).json({ message: 'Resource not found.' });
  if (!req.subscriptionOk && !isFreelyAccessible(row)) {
    return res.status(403).json({ message: 'Your trial has ended. Subscribe to unlock this content.', locked: true });
  }
  if (!row.stored_name) return res.status(404).json({ message: 'This resource has no previewable file.' });
  await streamR2Object(req, res, row.stored_name, { disposition: 'inline', mimeType: row.mime_type });
});

router.get('/bookmarks/mine', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT r.* FROM bookmarks b
    JOIN resources r ON r.id = b.resource_id
    WHERE b.user_id = ? AND r.publish_status = 'published'
    ORDER BY b.created_at DESC
  `).all(req.user.id);
  res.json({ resources: rows.map(serializeResource) });
});

router.get('/downloads/mine', requireAuth, (req, res) => {
  // Downloads have always been logged (see the /:id/download route below) -
  // this just surfaces that existing history so a student can find
  // something they downloaded before without re-searching for it, since
  // the file itself only goes to their device, not anywhere in their
  // account.
  const rows = db.prepare(`
    SELECT r.*, MAX(d.created_at) as last_downloaded_at
    FROM downloads d
    JOIN resources r ON r.id = d.resource_id
    WHERE d.user_id = ? AND r.publish_status = 'published'
    GROUP BY r.id
    ORDER BY last_downloaded_at DESC
  `).all(req.user.id);
  res.json({
    resources: rows.map((r) => ({ ...serializeResource(r), lastDownloadedAt: r.last_downloaded_at }))
  });
});

router.get('/:id', requireAuth, subscriptionGate, (req, res) => {
  const row = db.prepare(`SELECT * FROM resources WHERE id = ? AND publish_status = 'published'`).get(req.params.id);
  if (!row) return res.status(404).json({ message: 'Resource not found.' });
  if (!req.subscriptionOk && !isFreelyAccessible(row)) {
    return res.status(403).json({ message: 'Your trial has ended. Subscribe to unlock this content.', locked: true });
  }
  db.prepare('UPDATE resources SET view_count = view_count + 1 WHERE id = ?').run(row.id);
  res.json({ resource: serializeResource(row) });
});

router.get('/:id/download', requireAuth, subscriptionGate, async (req, res) => {
  const row = db.prepare(`SELECT * FROM resources WHERE id = ? AND publish_status = 'published'`).get(req.params.id);
  if (!row) return res.status(404).json({ message: 'Resource not found.' });
  if (!req.subscriptionOk && !isFreelyAccessible(row)) {
    return res.status(403).json({ message: 'Your trial has ended. Subscribe to unlock downloads.', locked: true });
  }
  if (row.category === 'video') {
    // Videos are stream-only, matching the "watch in the app, don't keep a
    // copy" model - enforced here so this can't be bypassed just by hitting
    // this URL directly instead of clicking a (deliberately absent) button.
    return res.status(403).json({ message: 'Videos are available to stream online only and cannot be downloaded.' });
  }

  if (row.external_url) {
    db.prepare('UPDATE resources SET download_count = download_count + 1 WHERE id = ?').run(row.id);
    return res.redirect(row.external_url);
  }
  if (!row.stored_name) return res.status(404).json({ message: 'This resource has no downloadable file.' });

  db.prepare('UPDATE resources SET download_count = download_count + 1 WHERE id = ?').run(row.id);
  db.prepare('INSERT INTO downloads (id, resource_id, user_id, created_at) VALUES (?, ?, ?, ?)')
    .run(`dl-${uuidv4()}`, row.id, req.user.id, new Date().toISOString());

  await streamR2Object(req, res, row.stored_name, {
    disposition: 'attachment',
    filename: row.file_name || row.stored_name,
    mimeType: row.mime_type
  });
});

router.post('/:id/bookmark', requireAuth, (req, res) => {
  const resource = db.prepare('SELECT id FROM resources WHERE id = ?').get(req.params.id);
  if (!resource) return res.status(404).json({ message: 'Resource not found.' });
  try {
    db.prepare('INSERT INTO bookmarks (id, user_id, resource_id, created_at) VALUES (?, ?, ?, ?)')
      .run(`bm-${uuidv4()}`, req.user.id, resource.id, new Date().toISOString());
  } catch {
    // already bookmarked - ignore (idempotent)
  }
  res.json({ message: 'Bookmarked.' });
});

router.delete('/:id/bookmark', requireAuth, (req, res) => {
  db.prepare('DELETE FROM bookmarks WHERE user_id = ? AND resource_id = ?').run(req.user.id, req.params.id);
  res.json({ message: 'Bookmark removed.' });
});

// ---- Lesson completion tracking (real, per student) -----------------------

router.post('/:id/complete', requireAuth, (req, res) => {
  const resource = db.prepare('SELECT id FROM resources WHERE id = ?').get(req.params.id);
  if (!resource) return res.status(404).json({ message: 'Resource not found.' });
  try {
    db.prepare('INSERT INTO lesson_progress (id, user_id, resource_id, completed_at) VALUES (?, ?, ?, ?)')
      .run(`lp-${uuidv4()}`, req.user.id, resource.id, new Date().toISOString());
  } catch {
    // already marked complete - idempotent, no error
  }
  res.json({ message: 'Marked as complete.' });
});

router.delete('/:id/complete', requireAuth, (req, res) => {
  db.prepare('DELETE FROM lesson_progress WHERE user_id = ? AND resource_id = ?').run(req.user.id, req.params.id);
  res.json({ message: 'Marked as not complete.' });
});

router.get('/completed/mine', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT resource_id, completed_at FROM lesson_progress WHERE user_id = ?').all(req.user.id);
  res.json({ completed: rows.map((r) => ({ resourceId: r.resource_id, completedAt: r.completed_at })) });
});

// ---- Quiz attempts (real score history, not just an in-browser popup) -----

router.post('/:id/quiz-attempt', requireAuth, (req, res) => {
  const { score, total } = req.body;
  if (typeof score !== 'number' || typeof total !== 'number' || total <= 0 || score < 0 || score > total) {
    return res.status(400).json({ message: 'Invalid score submitted.' });
  }
  const resource = db.prepare(`SELECT id, category FROM resources WHERE id = ?`).get(req.params.id);
  if (!resource || resource.category !== 'quiz') return res.status(404).json({ message: 'Quiz not found.' });

  db.prepare('INSERT INTO quiz_attempts (id, user_id, resource_id, score, total, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(`qa-${uuidv4()}`, req.user.id, resource.id, Math.round(score), Math.round(total), new Date().toISOString());

  // Completing a quiz also counts as completing that lesson, for progress
  // purposes - a student who has taken a topic quiz has engaged with it.
  try {
    db.prepare('INSERT INTO lesson_progress (id, user_id, resource_id, completed_at) VALUES (?, ?, ?, ?)')
      .run(`lp-${uuidv4()}`, req.user.id, resource.id, new Date().toISOString());
  } catch { /* already marked complete - fine */ }

  res.status(201).json({ message: 'Score recorded.' });
});

router.get('/:id/quiz-attempts/mine', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT score, total, created_at FROM quiz_attempts
    WHERE user_id = ? AND resource_id = ?
    ORDER BY created_at DESC
  `).all(req.user.id, req.params.id);
  const best = rows.reduce((max, r) => Math.max(max, r.total ? r.score / r.total : 0), 0);
  res.json({
    attempts: rows.map((r) => ({ score: r.score, total: r.total, createdAt: r.created_at })),
    bestPercent: Math.round(best * 100)
  });
});

module.exports = router;
