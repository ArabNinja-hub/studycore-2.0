const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const db = require('../db');
const { requireAuth, COOKIE_NAME } = require('../middleware/auth');
const { r2, bucketName } = require('../lib/r2');

const JWT_SECRET = process.env.JWT_SECRET || 'studycore-dev-secret-change-me';

const router = express.Router();

function serializeResource(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    subject: row.subject,
    course: row.course,
    topic: row.topic || null,
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
    pinned: Boolean(row.pinned),
    publishStatus: row.publish_status,
    downloadCount: row.download_count,
    viewCount: row.view_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// ---------------------------------------------------------------------------
// ACCESS MODEL (enforced server-side on every content request)
//
//   premium = ADMIN, or STUDENT with subscription='premium' that has not
//             expired (checked against the clock on every request, never
//             trusted from the client).
//   trial   = STUDENT who is not premium but whose server-stored trial_end
//             is still in the future.
//
//   Video lessons   -> premium ONLY. A trial (or expired) student never
//                      receives a video source, at any point.
//   Documents/notes -> premium OR active trial. Free previews (is_premium=0)
//                      and announcements are open to every logged-in student.
//
// The client never decides any of this - it only reflects it.
// ---------------------------------------------------------------------------

function accessFor(user) {
  const now = Date.now();
  const subEnd = new Date(user.subscription_end || 0).getTime();
  const trialEnd = new Date(user.trial_end || 0).getTime();
  const premium = user.role === 'ADMIN' || (user.subscription === 'premium' && now < subEnd);
  const trial = !premium && user.role === 'STUDENT' && now < trialEnd;
  return { user, premium, trial };
}

function gate(req, res, next) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ message: 'User not found.' });
  req.user = user; // freshest row - never act on the token payload alone
  req.access = accessFor(user);
  next();
}

// Can this student open this specific resource right now?
function canAccess(row, access) {
  if (row.category === 'announcement') return true;
  if (!row.is_premium) return true; // free preview
  if (row.category === 'video') return access.premium; // videos are Premium-only, always
  return access.premium || access.trial; // documents, tutorials, past papers
}

// Why it's locked (drives the exact upgrade message the student sees):
// 'video' -> Premium Video wall; 'premium' -> trial expired wall.
function lockReason(row, access) {
  if (row.category === 'video' && !access.premium) return 'video';
  if (!access.premium && !access.trial) return 'premium';
  return null;
}

// Fetches an object from R2 and pipes it to the response. Honors HTTP Range
// requests (the browser sends these automatically when someone scrubs/seeks
// within a video, or resumes an interrupted download) by forwarding the
// same Range header straight through to R2's GetObjectCommand - without
// this, video playback would still start fine but skipping ahead in the
// player wouldn't work properly.
//
// Protected media is streamed with no-store so neither the browser nor any
// intermediate proxy is encouraged to cache a chunk of Premium content that
// only this authorized session was allowed to fetch.
const MIME_BY_EXT = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav'
};

function inferMime(row) {
  const given = String(row.mime_type || '').trim();
  if (given && given !== 'application/octet-stream' && given !== 'binary/octet-stream') return given;
  const name = String(row.file_name || row.stored_name || '');
  const ext = path.extname(name).toLowerCase();
  return MIME_BY_EXT[ext] || given || 'application/octet-stream';
}

function pipeBodyToResponse(body, res) {
  if (!body) {
    if (!res.writableEnded) res.end();
    return;
  }
  const fail = () => {
    if (!res.headersSent) res.status(500);
    if (!res.writableEnded) res.end();
  };
  if (typeof body.pipe === 'function') {
    body.on('error', fail);
    body.pipe(res);
    return;
  }
  // AWS SDK v3 may hand back a Web ReadableStream (no .pipe).
  if (typeof Readable.fromWeb === 'function' && typeof body.getReader === 'function') {
    const nodeStream = Readable.fromWeb(body);
    nodeStream.on('error', fail);
    nodeStream.pipe(res);
    return;
  }
  fail();
}

function r2StreamError(err, res) {
  if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
    return res.status(404).json({ message: 'File is missing from storage.' });
  }
  console.error('R2 stream error:', err.message);
  return res.status(502).json({ message: 'Could not reach file storage. Please try again shortly.' });
}

async function streamR2Object(req, res, key, { disposition, filename, mimeType }) {
  if (!bucketName || !process.env.R2_ACCOUNT_ID || !process.env.R2_ACCESS_KEY_ID) {
    return res.status(503).json({ message: 'File storage is not configured yet, so this file cannot be opened.' });
  }

  let object;
  try {
    object = await r2.send(new GetObjectCommand({
      Bucket: bucketName,
      Key: key,
      Range: req.headers.range || undefined
    }));
  } catch (err) {
    // A player always sends Range. If the object store rejects it, retry the
    // full object so playback/preview still starts.
    if (req.headers.range) {
      try {
        object = await r2.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
      } catch (err2) {
        return r2StreamError(err2, res);
      }
    } else {
      return r2StreamError(err, res);
    }
  }

  const type = (object.ContentType && object.ContentType !== 'application/octet-stream')
    ? object.ContentType
    : (mimeType || 'application/octet-stream');

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', type);
  if (object.ContentLength !== undefined) res.setHeader('Content-Length', object.ContentLength);

  const safeName = String(filename || key).replace(/"/g, '');
  const dispositionValue = disposition === 'attachment'
    ? `attachment; filename="${safeName}"`
    : `inline; filename="${safeName}"`;
  res.setHeader('Content-Disposition', dispositionValue);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Robots-Tag', 'noindex, noarchive, nosnippet');
  // Allow the same-origin document viewer iframe to embed this stream.
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");

  if (object.ContentRange) {
    res.status(206);
    res.setHeader('Content-Range', object.ContentRange);
  } else {
    res.status(200);
  }

  pipeBodyToResponse(object.Body, res);
}

function lockedResponse(res, reason) {
  const messages = {
    video: 'Video lessons are available exclusively to StudyCore Premium students. Upgrade to unlock this video.',
    premium: 'Your free access period has ended. Upgrade to StudyCore Premium to continue reading this resource.'
  };
  return res.status(403).json({ message: messages[reason] || 'This content is not available with your current plan.', locked: true, lockReason: reason });
}

// GET /api/resources?category=&subject=&course=&year=&semester=&search=&sort=&page=&pageSize=
//
// Returns every PUBLISHED resource (admins' drafts never appear) with a
// `locked` flag computed per the student's current server-side access.
// Locked items are listed so the UI can show an honest "Premium" upgrade
// card - but their files are still only served after the checks above.
router.get('/', requireAuth, gate, (req, res) => {
  const { category, excludeCategory, subject, course, topic, year, semester, search, sort = 'newest', page = 1, pageSize = 24 } = req.query;

  // category / excludeCategory accept comma-separated lists
  // (e.g. excludeCategory=video,quiz,assignment)
  const cats = String(category || '').split(',').map((c) => c.trim()).filter(Boolean);
  const excluded = String(excludeCategory || '').split(',').map((c) => c.trim()).filter(Boolean);

  const clauses = [`publish_status = 'published'`];
  const params = {};
  if (cats.length === 1) { clauses.push('category = @category'); params.category = cats[0]; }
  else if (cats.length > 1) { clauses.push(`category IN (${cats.map((_, i) => `@cat${i}`).join(',')})`); cats.forEach((c, i) => { params[`cat${i}`] = c; }); }
  if (excluded.length === 1) { clauses.push('category != @excluded'); params.excluded = excluded[0]; }
  else if (excluded.length > 1) { clauses.push(`category NOT IN (${excluded.map((_, i) => `@exc${i}`).join(',')})`); excluded.forEach((c, i) => { params[`exc${i}`] = c; }); }
  if (subject) { clauses.push('LOWER(subject) = LOWER(@subject)'); params.subject = subject; }
  if (course) { clauses.push('course = @course'); params.course = course; }
  if (topic) { clauses.push('LOWER(topic) = LOWER(@topic)'); params.topic = topic; }
  if (year) { clauses.push('year_level = @year'); params.year = year; }
  if (semester) { clauses.push('semester = @semester'); params.semester = semester; }
  if (search) {
    clauses.push('(title LIKE @search OR description LIKE @search OR subject LIKE @search OR tags LIKE @search OR topic LIKE @search)');
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

  res.json({
    resources: rows.map((row) => ({
      ...serializeResource(row),
      locked: canAccess(row, req.access) ? null : lockReason(row, req.access),
      completed: db.prepare('SELECT 1 AS x FROM lesson_progress WHERE user_id = ? AND resource_id = ?').get(req.user.id, row.id) ? true : false
    })),
    total,
    page: Number(page),
    pageSize: limit,
    access: { premium: req.access.premium, trial: req.access.trial }
  });
});

router.get('/:id/stream', requireAuth, gate, async (req, res) => {
  const row = db.prepare(`SELECT * FROM resources WHERE id = ? AND publish_status = 'published'`).get(req.params.id);
  if (!row) return res.status(404).json({ message: 'Resource not found.' });
  if (!canAccess(row, req.access)) return lockedResponse(res, lockReason(row, req.access));
  if (!row.stored_name && !row.external_url) return res.status(404).json({ message: 'This resource has no previewable file.' });
  if (row.external_url) return res.status(404).json({ message: 'This resource has no previewable file.' });
  await streamR2Object(req, res, row.stored_name, {
    disposition: 'inline',
    filename: row.file_name || row.stored_name,
    mimeType: inferMime(row)
  });
});

// ---- Video playback progress (server-stored resume position) ---------------
//
// Only Premium-authorized video playback may read or write progress: the
// resume position of a protected video is itself protected content, so a
// trial/expired student querying it gets the same 403 as the stream.

router.post('/:id/video-progress', requireAuth, gate, (req, res) => {
  const row = db.prepare(`SELECT * FROM resources WHERE id = ? AND publish_status = 'published'`).get(req.params.id);
  if (!row || row.category !== 'video') return res.status(404).json({ message: 'Video lesson not found.' });
  if (!canAccess(row, req.access)) return lockedResponse(res, 'video');

  const { position, duration } = req.body || {};
  const pos = Number(position);
  const dur = Number(duration);
  // Reject garbage before it ever touches the database - a position is a
  // sane number of seconds, bounded to a 6-hour "video".
  if (!Number.isFinite(pos) || !Number.isFinite(dur) || pos < 0 || dur <= 0 || dur > 21600 || pos > dur) {
    return res.status(400).json({ message: 'Invalid playback position.' });
  }

  const now = new Date().toISOString();
  try {
    db.prepare(`
      INSERT INTO video_progress (id, user_id, resource_id, position, duration, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, resource_id) DO UPDATE SET position = excluded.position, duration = excluded.duration, updated_at = excluded.updated_at
    `).run(`vp-${uuidv4()}`, req.user.id, row.id, pos, dur, now);
  } catch (err) {
    return res.status(500).json({ message: 'Could not save your position.' });
  }

  // 90% of the way through counts as having watched the lesson - the
  // completion itself is the real progress record, written server-side.
  if (pos / dur >= 0.9) {
    try {
      db.prepare('INSERT INTO lesson_progress (id, user_id, resource_id, completed_at) VALUES (?, ?, ?, ?)')
        .run(`lp-${uuidv4()}`, req.user.id, row.id, now);
    } catch { /* already complete - idempotent */ }
  }

  res.json({ message: 'Position saved.' });
});

router.get('/:id/video-progress', requireAuth, gate, (req, res) => {
  const row = db.prepare(`SELECT * FROM resources WHERE id = ? AND publish_status = 'published'`).get(req.params.id);
  if (!row || row.category !== 'video') return res.status(404).json({ message: 'Video lesson not found.' });
  if (!canAccess(row, req.access)) return lockedResponse(res, 'video');

  const saved = db.prepare('SELECT position, duration, updated_at FROM video_progress WHERE user_id = ? AND resource_id = ?').get(req.user.id, row.id);
  res.json({ position: saved ? saved.position : 0, duration: saved ? saved.duration : 0, updatedAt: saved ? saved.updated_at : null });
});

router.get('/bookmarks/mine', requireAuth, gate, (req, res) => {
  const rows = db.prepare(`
    SELECT r.* FROM bookmarks b
    JOIN resources r ON r.id = b.resource_id
    WHERE b.user_id = ? AND r.publish_status = 'published'
    ORDER BY b.created_at DESC
  `).all(req.user.id);
  res.json({ resources: rows.map((r) => ({ ...serializeResource(r), locked: canAccess(r, req.access) ? null : lockReason(r, req.access) })) });
});

router.get('/downloads/mine', requireAuth, gate, (req, res) => {
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
    resources: rows.map((r) => ({ ...serializeResource(r), lastDownloadedAt: r.last_downloaded_at, locked: canAccess(r, req.access) ? null : lockReason(r, req.access) }))
  });
});

router.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  const limit = Math.min(Number(req.query.limit) || 8, 20);
  if (!q) return res.json({ query: '', courses: [], topics: [], results: [], authenticated: false });

  // Optional session - search works for anonymous visitors at a reduced scope.
  let user = null;
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.id);
    } catch { user = null; }
  }
  const access = user ? accessFor(user) : { premium: false, trial: false };
  const ql = `%${q}%`;

  // 1) Courses (always public - they are the site's core navigation).
  const courses = COURSE_SUBJECTS.filter((c) => c.subject.toLowerCase().includes(q.toLowerCase()))
    .map((c) => ({ slug: c.slug, subject: c.subject }));

  // 2) Topics (names only - public structure of each course).
  const topicRows = db.prepare(`
    SELECT DISTINCT topic, LOWER(subject) AS subject_key, subject
    FROM resources
    WHERE publish_status = 'published' AND topic IS NOT NULL AND topic != ''
    ORDER BY topic ASC
  `).all();
  const topics = topicRows
    .filter((t) => t.topic.toLowerCase().includes(q.toLowerCase()) || (t.subject || '').toLowerCase().includes(q.toLowerCase()))
    .slice(0, limit)
    .map((t) => ({ topic: t.topic, subject: t.subject, slug: COURSE_SUBJECTS.find((c) => c.subject === t.subject)?.slug || '' }));

  // 3) Content (only for logged-in students, permission-flagged).
  let results = [];
  if (user) {
    const rows = db.prepare(`
      SELECT * FROM resources
      WHERE publish_status = 'published'
        AND category NOT IN ('announcement', 'quiz', 'assignment')
        AND (title LIKE ? OR description LIKE ? OR topic LIKE ? OR tags LIKE ? OR subject LIKE ?)
      ORDER BY
        CASE category WHEN 'video' THEN 0 WHEN 'document' THEN 1 WHEN 'tutorial' THEN 2 ELSE 3 END,
        created_at DESC
      LIMIT ?
    `).all(ql, ql, ql, ql, ql, limit);

    const completed = new Set(
      db.prepare('SELECT resource_id FROM lesson_progress WHERE user_id = ?').all(user.id).map((r) => r.resource_id)
    );
    results = rows.map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      category: row.category,
      subject: row.subject,
      topic: row.topic || null,
      completed: completed.has(row.id),
      locked: canAccess(row, access) ? null : lockReason(row, access)
    }));
  }

  res.json({
    query: q,
    courses,
    topics,
    results,
    authenticated: Boolean(user)
  });
});

router.get('/:id', requireAuth, gate, (req, res) => {
  const row = db.prepare(`SELECT * FROM resources WHERE id = ? AND publish_status = 'published'`).get(req.params.id);
  if (!row) return res.status(404).json({ message: 'Resource not found.' });
  if (!canAccess(row, req.access)) return lockedResponse(res, lockReason(row, req.access));
  db.prepare('UPDATE resources SET view_count = view_count + 1 WHERE id = ?').run(row.id);
  res.json({ resource: serializeResource(row) });
});

router.get('/:id/download', requireAuth, gate, async (req, res) => {
  const row = db.prepare(`SELECT * FROM resources WHERE id = ? AND publish_status = 'published'`).get(req.params.id);
  if (!row) return res.status(404).json({ message: 'Resource not found.' });
  if (!canAccess(row, req.access)) return lockedResponse(res, lockReason(row, req.access));
  if (row.category === 'video') {
    // Videos are stream-only, matching the "watch in the app, don't keep a
    // copy" model - enforced here so this can't be bypassed just by hitting
    // this URL directly instead of clicking a (deliberately absent) button.
    return res.status(403).json({ message: 'Videos are available to stream online only and cannot be downloaded.', locked: true });
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
    mimeType: inferMime(row)
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

// ---------------------------------------------------------------------------
// GLOBAL SEARCH (permission-aware)
//
// One query across courses, topics, lessons, past papers and announcements.
// Anonymous visitors get courses + topics only (that is public knowledge);
// logged-in students also get content results - each with the same `locked`
// flag the rest of the platform uses, so a trial student searching never
// receives a protected video result they could open, only an honest
// "Premium" card. Results link to pages, never to raw file URLs.
// ---------------------------------------------------------------------------

const COURSE_SUBJECTS = [
  { slug: 'mathematics', subject: 'Mathematics' },
  { slug: 'physics', subject: 'Physics' },
  { slug: 'chemistry', subject: 'Chemistry' },
  { slug: 'biology', subject: 'Biology' },
  { slug: 'programming', subject: 'Programming' },
  { slug: 'communication', subject: 'Communication Skills' }
];

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

// ---- Quiz attempts (kept for backend/admin compatibility) ------------------
//
// Quizzes are no longer part of the student learning experience, but the
// storage and endpoints remain so admin-managed quiz records (and any
// historical score data) stay intact and nothing referencing the table
// breaks.

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
