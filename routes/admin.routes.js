const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { upload } = require('../middleware/upload');
const { r2, bucketName } = require('../lib/r2');

const router = express.Router();
router.use(requireAuth, requireRole('ADMIN'));

// Keeps the Video library genuinely video-only and the Document library
// genuinely document-only - without this, nothing stops an admin from
// picking the wrong category for a file (e.g. a .pdf tagged as "video"),
// which would silently land in the wrong place with a broken player or a
// document that never streams.
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi']);
const DOCUMENT_LIKE_CATEGORIES = new Set(['document', 'tutorial', 'past_paper', 'assignment']);

function validateFileMatchesCategory(category, file) {
  if (!file) return null;
  const ext = path.extname(file.originalname).toLowerCase();
  if (category === 'video' && !VIDEO_EXTENSIONS.has(ext)) {
    return `"${ext}" is not a video file. Videos must be uploaded under the Video Lesson category as an actual video file (.mp4, .mov, .webm, .mkv, or .avi).`;
  }
  if (DOCUMENT_LIKE_CATEGORIES.has(category) && VIDEO_EXTENSIONS.has(ext)) {
    return `This looks like a video file. Please use the Video Lesson category for videos, so it plays properly for students instead of landing in the wrong library.`;
  }
  return null;
}

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

function deleteFileIfExists(storedKey) {
  if (!storedKey) return;
  // Fire-and-forget, same as the old local-disk version - a resource row
  // being deleted shouldn't be blocked or fail because R2 was briefly slow.
  r2.send(new DeleteObjectCommand({ Bucket: bucketName, Key: storedKey })).catch(() => {});
}

// ---- Resource CRUD -------------------------------------------------------

// GET all resources for the management table (includes drafts, supports search/filter/sort)
router.get('/resources', (req, res) => {
  const { category, subject, search, sort = 'newest', publishStatus } = req.query;
  const clauses = [];
  const params = {};
  if (category) { clauses.push('category = @category'); params.category = category; }
  if (subject) { clauses.push('subject = @subject'); params.subject = subject; }
  if (publishStatus) { clauses.push('publish_status = @publishStatus'); params.publishStatus = publishStatus; }
  if (search) {
    clauses.push('(title LIKE @search OR description LIKE @search OR tags LIKE @search)');
    params.search = `%${search}%`;
  }
  const sortMap = {
    newest: 'created_at DESC',
    oldest: 'created_at ASC',
    popular: 'download_count DESC',
    title: 'title ASC'
  };
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM resources ${where} ORDER BY ${sortMap[sort] || sortMap.newest}`).all(params);
  res.json({ resources: rows.map(serializeResource) });
});

router.post('/resources', upload.single('file'), (req, res) => {
  const { title, description, category, subject, course, yearLevel, semester, tags, externalUrl, quizData, dueDate, publishStatus, isPremium } = req.body;

  if (!title || !title.trim()) return res.status(400).json({ message: 'Title is required.' });
  if (!category) return res.status(400).json({ message: 'Category is required.' });
  if (category === 'quiz' && !quizData) return res.status(400).json({ message: 'Quiz questions (JSON) are required for quizzes.' });
  if (category === 'video' && !req.file) {
    // Videos are watch-on-site only, uploaded and streamed like Netflix -
    // never a link out to YouTube or anywhere else, so a real file is
    // mandatory here rather than optional.
    return res.status(400).json({ message: 'Please upload an actual video file - external video links are no longer supported.' });
  }

  const categoryMismatch = validateFileMatchesCategory(category, req.file);
  if (categoryMismatch) {
    // Multer already streamed the file to R2 by this point - clean it up
    // rather than leaving an orphaned object with no matching resource row.
    if (req.file && req.file.key) {
      r2.send(new DeleteObjectCommand({ Bucket: bucketName, Key: req.file.key })).catch(() => {});
    }
    return res.status(400).json({ message: categoryMismatch });
  }

  if (quizData) {
    try { JSON.parse(quizData); } catch { return res.status(400).json({ message: 'Quiz questions must be valid JSON.' }); }
  }

  const now = new Date().toISOString();
  const id = `res-${uuidv4()}`;
  let contentHash = null;
  let duplicateOf = null;

  if (req.file) {
    contentHash = req.file.contentHash;
    const existingDuplicate = db.prepare(`
      SELECT id, title FROM resources WHERE content_hash = ? AND id != ? LIMIT 1
    `).get(contentHash, id);
    if (existingDuplicate) duplicateOf = existingDuplicate;
  }

  const row = {
    id,
    title: title.trim(),
    description: description || null,
    category,
    subject: subject || null,
    course: course || null,
    year_level: yearLevel || null,
    semester: semester || null,
    tags: tags || null,
    file_name: req.file ? req.file.originalname : null,
    stored_name: req.file ? req.file.key : null,
    file_size: req.file ? req.file.size : null,
    mime_type: req.file ? req.file.mimetype : null,
    content_hash: contentHash,
    external_url: category === 'video' ? null : (externalUrl || null),
    quiz_data: quizData || null,
    due_date: dueDate || null,
    is_premium: isPremium === 'false' || isPremium === '0' ? 0 : 1,
    publish_status: publishStatus || 'published',
    uploaded_by: req.user.id,
    created_at: now,
    updated_at: now
  };

  db.prepare(`
    INSERT INTO resources (id, title, description, category, subject, course, year_level, semester, tags,
      file_name, stored_name, file_size, mime_type, content_hash, external_url, quiz_data, due_date, is_premium, publish_status, uploaded_by, created_at, updated_at)
    VALUES (@id, @title, @description, @category, @subject, @course, @year_level, @semester, @tags,
      @file_name, @stored_name, @file_size, @mime_type, @content_hash, @external_url, @quiz_data, @due_date, @is_premium, @publish_status, @uploaded_by, @created_at, @updated_at)
  `).run(row);

  const saved = db.prepare('SELECT * FROM resources WHERE id = ?').get(id);
  const response = { resource: serializeResource(saved) };
  if (duplicateOf) {
    response.warning = `This file appears to be identical to an existing resource: "${duplicateOf.title}". Both have been kept - delete the one you don't need from the resource table below.`;
  }
  res.status(201).json(response);
});

router.put('/resources/:id', upload.single('file'), (req, res) => {
  const existing = db.prepare('SELECT * FROM resources WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ message: 'Resource not found.' });

  const { title, description, category, subject, course, yearLevel, semester, tags, externalUrl, quizData, dueDate, publishStatus, isPremium } = req.body;

  const effectiveCategory = category ?? existing.category;
  const categoryMismatch = validateFileMatchesCategory(effectiveCategory, req.file);
  if (categoryMismatch) {
    if (req.file && req.file.key) {
      r2.send(new DeleteObjectCommand({ Bucket: bucketName, Key: req.file.key })).catch(() => {});
    }
    return res.status(400).json({ message: categoryMismatch });
  }

  if (quizData) {
    try { JSON.parse(quizData); } catch { return res.status(400).json({ message: 'Quiz questions must be valid JSON.' }); }
  }

  let fileFields = {
    file_name: existing.file_name,
    stored_name: existing.stored_name,
    file_size: existing.file_size,
    mime_type: existing.mime_type,
    content_hash: existing.content_hash
  };

  if (req.file) {
    deleteFileIfExists(existing.stored_name);
    fileFields = {
      file_name: req.file.originalname,
      stored_name: req.file.key,
      file_size: req.file.size,
      mime_type: req.file.mimetype,
      content_hash: req.file.contentHash
    };
  }

  const updated = {
    id: existing.id,
    title: (title ?? existing.title).trim(),
    description: description ?? existing.description,
    category: category ?? existing.category,
    subject: subject ?? existing.subject,
    course: course ?? existing.course,
    year_level: yearLevel ?? existing.year_level,
    semester: semester ?? existing.semester,
    tags: tags ?? existing.tags,
    external_url: (category ?? existing.category) === 'video' ? null : (externalUrl ?? existing.external_url),
    quiz_data: quizData ?? existing.quiz_data,
    due_date: dueDate ?? existing.due_date,
    is_premium: isPremium === undefined ? existing.is_premium : (isPremium === 'false' || isPremium === '0' ? 0 : 1),
    publish_status: publishStatus ?? existing.publish_status,
    updated_at: new Date().toISOString(),
    ...fileFields
  };

  db.prepare(`
    UPDATE resources SET title=@title, description=@description, category=@category, subject=@subject, course=@course,
      year_level=@year_level, semester=@semester, tags=@tags, external_url=@external_url, quiz_data=@quiz_data,
      due_date=@due_date, is_premium=@is_premium, publish_status=@publish_status, updated_at=@updated_at,
      file_name=@file_name, stored_name=@stored_name, file_size=@file_size, mime_type=@mime_type, content_hash=@content_hash
    WHERE id=@id
  `).run(updated);

  const saved = db.prepare('SELECT * FROM resources WHERE id = ?').get(existing.id);
  res.json({ resource: serializeResource(saved) });
});

router.delete('/resources/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM resources WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ message: 'Resource not found.' });
  deleteFileIfExists(existing.stored_name);
  db.prepare('DELETE FROM resources WHERE id = ?').run(existing.id);
  res.json({ message: 'Resource deleted.' });
});

// ---- Users ---------------------------------------------------------------

router.get('/users', (req, res) => {
  const users = db.prepare(`
    SELECT id, name, email, role, school, grade, learning_level, subscription, trial_end, subscription_start, subscription_end, created_at
    FROM users ORDER BY created_at DESC
  `).all();
  res.json({ users });
});

router.delete('/users/:id', (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ message: 'You cannot delete your own account.' });
  const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ message: 'User not found.' });
  if (user.role === 'ADMIN') return res.status(400).json({ message: 'Admin accounts cannot be removed here.' });
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ message: 'Student account removed.' });
});

// ---- Subscription payments (manual mobile-money confirmation) -----------

router.get('/payments', (req, res) => {
  const status = req.query.status; // optional filter: PENDING, SUCCESS, REJECTED
  const clause = status ? 'WHERE p.status = @status' : '';
  const rows = db.prepare(`
    SELECT p.*, u.name as student_name, u.email as student_email
    FROM payments p
    JOIN users u ON u.id = p.user_id
    ${clause}
    ORDER BY p.created_at DESC
  `).all(status ? { status } : {});
  res.json({ payments: rows });
});

router.post('/payments/:id/approve', (req, res) => {
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
  if (!payment) return res.status(404).json({ message: 'Payment request not found.' });
  if (payment.status !== 'PENDING') return res.status(400).json({ message: 'This payment has already been reviewed.' });

  const now = new Date().toISOString();
  const subEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  db.prepare(`UPDATE payments SET status = 'SUCCESS', reviewed_at = ?, reviewed_by = ? WHERE id = ?`)
    .run(now, req.user.id, payment.id);
  db.prepare(`UPDATE users SET subscription = 'premium', subscription_start = ?, subscription_end = ? WHERE id = ?`)
    .run(now, subEnd, payment.user_id);

  res.json({ message: 'Payment approved - the student now has 30 days of premium access.' });
});

router.post('/payments/:id/reject', (req, res) => {
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
  if (!payment) return res.status(404).json({ message: 'Payment request not found.' });
  if (payment.status !== 'PENDING') return res.status(400).json({ message: 'This payment has already been reviewed.' });

  db.prepare(`UPDATE payments SET status = 'REJECTED', reviewed_at = ?, reviewed_by = ? WHERE id = ?`)
    .run(new Date().toISOString(), req.user.id, payment.id);

  res.json({ message: 'Payment marked as rejected.' });
});

// ---- Analytics -------------------------------------------------------------

router.get('/analytics', (req, res) => {
  const totalUsers = db.prepare(`SELECT COUNT(*) c FROM users`).get().c;
  const totalStudents = db.prepare(`SELECT COUNT(*) c FROM users WHERE role = 'STUDENT'`).get().c;
  const premiumStudents = db.prepare(`SELECT COUNT(*) c FROM users WHERE role = 'STUDENT' AND subscription = 'premium'`).get().c;
  const totalResources = db.prepare(`SELECT COUNT(*) c FROM resources`).get().c;
  const publishedResources = db.prepare(`SELECT COUNT(*) c FROM resources WHERE publish_status = 'published'`).get().c;
  const totalDownloads = db.prepare(`SELECT COALESCE(SUM(download_count),0) c FROM resources`).get().c;
  const totalViews = db.prepare(`SELECT COALESCE(SUM(view_count),0) c FROM resources`).get().c;
  const revenue = db.prepare(`SELECT COALESCE(SUM(amount),0) c FROM payments WHERE status = 'SUCCESS'`).get().c;

  const byCategory = db.prepare(`
    SELECT category, COUNT(*) as count FROM resources GROUP BY category
  `).all();

  const popular = db.prepare(`
    SELECT id, title, category, download_count FROM resources ORDER BY download_count DESC LIMIT 5
  `).all();

  const mostViewed = db.prepare(`
    SELECT id, title, category, view_count FROM resources WHERE view_count > 0 ORDER BY view_count DESC LIMIT 5
  `).all();

  const recentUploads = db.prepare(`
    SELECT id, title, category, created_at FROM resources ORDER BY created_at DESC LIMIT 5
  `).all();

  const storageUsedBytes = db.prepare(`SELECT COALESCE(SUM(file_size),0) c FROM resources`).get().c;

  const recentActivity = db.prepare(`
    SELECT d.created_at, r.title, u.name as student_name
    FROM downloads d
    JOIN resources r ON r.id = d.resource_id
    LEFT JOIN users u ON u.id = d.user_id
    ORDER BY d.created_at DESC LIMIT 8
  `).all();

  res.json({
    totalUsers,
    totalStudents,
    premiumStudents,
    totalResources,
    publishedResources,
    totalDownloads,
    totalViews,
    revenue,
    storageUsedBytes,
    byCategory,
    popular,
    mostViewed,
    recentUploads,
    recentActivity
  });
});

module.exports = router;
