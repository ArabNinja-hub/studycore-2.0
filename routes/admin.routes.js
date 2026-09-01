const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { upload } = require('../middleware/upload');
const storage = require('../lib/storage');
const { sendAccessGrantedEmail } = require('../lib/mailer');
const { resolveCourse } = require('../lib/program-access');
// Resource creation, validation and targeting live in one shared module so
// the admin dashboard and the code-gated upload portal behave identically.
const {
  validateCoursePlacement,
  parseTargeting,
  syncResourcePrograms,
  validateFileMatchesCategory,
  serializeResource,
  deleteFileIfExists,
  createResource
} = require('../lib/resource-intake');

const router = express.Router();
router.use(requireAuth, requireRole('ADMIN'));

// ---- Resource CRUD -------------------------------------------------------

// GET all resources for the management table (includes drafts, supports search/filter/sort)
// Program filter: ?program=LAW shows content targeted at LAW OR all-programs;
// ?program=LAW&scope=exact shows ONLY content specifically targeting LAW.
router.get('/resources', (req, res) => {
  const { category, subject, search, sort = 'newest', publishStatus, program, scope } = req.query;
  const clauses = [];
  const params = {};
  if (category) { clauses.push('category = @category'); params.category = category; }
  if (subject) { clauses.push('subject = @subject'); params.subject = subject; }
  if (publishStatus) { clauses.push('publish_status = @publishStatus'); params.publishStatus = publishStatus; }
  if (program) {
    const code = String(program).toUpperCase();
    if (scope === 'exact') {
      clauses.push(`target_all = 0 AND EXISTS (SELECT 1 FROM resource_programs rp WHERE rp.resource_id = resources.id AND rp.program_code = @program)`);
    } else {
      clauses.push(`(target_all = 1 OR EXISTS (SELECT 1 FROM resource_programs rp WHERE rp.resource_id = resources.id AND rp.program_code = @program))`);
    }
    params.program = code;
  }
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
  const { status, body } = createResource({ body: req.body, file: req.file, uploaderId: req.user.id });
  res.status(status).json(body);
});

router.put('/resources/:id', upload.single('file'), (req, res) => {
  const existing = db.prepare('SELECT * FROM resources WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ message: 'Resource not found.' });

  const { title, description, category, subject, course, courseId, topic, yearLevel, semester, tags, externalUrl, quizData, dueDate, publishStatus, isPremium, pinned } = req.body;

  const effectiveCategory = category ?? existing.category;

  // Dynamic course: resolve when supplied; keep existing when omitted.
  let courseRow = null;
  let effectiveCourseId = existing.course_id;
  if (courseId !== undefined) {
    if (courseId) {
      courseRow = resolveCourse(courseId);
      if (!courseRow) return res.status(400).json({ message: 'The selected course could not be found.' });
      effectiveCourseId = courseRow.id;
    } else {
      effectiveCourseId = null;
    }
  } else if (existing.course_id) {
    courseRow = db.prepare('SELECT * FROM courses WHERE id = ?').get(existing.course_id);
  }

  const subjectChanged = subject !== undefined;
  const effectiveSubject = subjectChanged
    ? (subject || (courseRow ? courseRow.name : null))
    : (existing.subject || (courseRow ? courseRow.name : null));
  const effectiveSemester = semester ?? existing.semester;
  // Enforce placement when the admin is editing placement fields or replacing
  // the file, while still allowing a publish toggle on older legacy rows that
  // predate required video terms.
  const placementChanged = category !== undefined || subject !== undefined || courseId !== undefined || semester !== undefined || Boolean(req.file);
  const placementError = placementChanged
    ? validateCoursePlacement(effectiveCategory, effectiveSubject, effectiveSemester, effectiveCourseId)
    : null;
  if (placementError) return res.status(400).json({ message: placementError });

  const categoryMismatch = validateFileMatchesCategory(effectiveCategory, req.file);
  if (categoryMismatch) {
    if (req.file && req.file.key) {
      storage.deleteObject(req.file.key).catch(() => {});
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

  // Program targeting — only re-synced when the admin sends targeting fields.
  if (req.body.targetAll !== undefined || req.body.programs !== undefined || req.body.targetPrograms !== undefined || req.body.target !== undefined) {
    const targeting = parseTargeting(req.body);
    db.prepare('UPDATE resources SET target_all = ? WHERE id = ?').run(targeting.targetAll ? 1 : 0, existing.id);
    syncResourcePrograms(existing.id, targeting.targetAll, targeting.programCodes);
  }

  const updated = {
    id: existing.id,
    title: (title ?? existing.title).trim(),
    description: description ?? existing.description,
    category: category ?? existing.category,
    subject: effectiveSubject ?? existing.subject,
    course: course ?? existing.course,
    course_id: effectiveCourseId ?? existing.course_id,
    topic: topic === undefined ? existing.topic : ((topic || '').trim() || null),
    year_level: yearLevel ?? existing.year_level,
    semester: semester ?? existing.semester,
    tags: tags ?? existing.tags,
    pinned: pinned === undefined ? existing.pinned : (pinned === 'true' || pinned === '1' ? 1 : 0),
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
      course_id=@course_id, topic=@topic, year_level=@year_level, semester=@semester, tags=@tags, external_url=@external_url,
      quiz_data=@quiz_data, due_date=@due_date, is_premium=@is_premium, pinned=@pinned, publish_status=@publish_status,
      updated_at=@updated_at, file_name=@file_name, stored_name=@stored_name, file_size=@file_size, mime_type=@mime_type,
      content_hash=@content_hash
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
  const { program } = req.query;
  const clauses = [];
  const params = {};
  if (program) {
    if (program === 'none') clauses.push('program_code IS NULL');
    else { clauses.push('program_code = @program'); params.program = String(program).toUpperCase(); }
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const users = db.prepare(`
    SELECT id, name, email, role, school, grade, learning_level, program_code, subscription, trial_end, subscription_start, subscription_end, created_at
    FROM users ${where}
    ORDER BY created_at DESC
  `).all(params);
  // Attach program display info for the management table.
  const programs = db.prepare('SELECT * FROM programs').all();
  const byCode = new Map(programs.map((p) => [p.code, p]));
  const enriched = users.map((u) => ({
    ...u,
    program: u.program_code || null,
    programName: u.program_code ? (byCode.get(u.program_code)?.name || u.program_code) : null
  }));
  res.json({ users: enriched });
});

// Admin can change a student's program (e.g. a student who picked the wrong
// category). Validated against the real programs table.
router.put('/users/:id/program', (req, res) => {
  const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ message: 'User not found.' });
  if (user.role === 'ADMIN') return res.status(400).json({ message: 'Admin accounts do not have a student program.' });
  const code = String((req.body && req.body.program) || '').trim().toUpperCase();
  if (!code) {
    db.prepare('UPDATE users SET program_code = NULL WHERE id = ?').run(user.id);
    return res.json({ message: 'Program cleared.' });
  }
  if (!VALID_PROGRAM_CODES.has(code) || !db.prepare('SELECT code FROM programs WHERE code = ?').get(code)) {
    return res.status(400).json({ message: 'That program does not exist.' });
  }
  db.prepare('UPDATE users SET program_code = ? WHERE id = ?').run(code, user.id);
  res.json({ message: `Student's program updated to ${code}.` });
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

router.post('/payments/:id/approve', async (req, res) => {
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
  if (!payment) return res.status(404).json({ message: 'Payment request not found.' });
  if (payment.status !== 'PENDING') return res.status(400).json({ message: 'This payment has already been reviewed.' });

  const student = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(payment.user_id);

  const now = new Date().toISOString();
  const subEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  db.prepare(`UPDATE payments SET status = 'SUCCESS', reviewed_at = ?, reviewed_by = ? WHERE id = ?`)
    .run(now, req.user.id, payment.id);
  db.prepare(`UPDATE users SET subscription = 'premium', subscription_start = ?, subscription_end = ? WHERE id = ?`)
    .run(now, subEnd, payment.user_id);

  // The student just paid and is waiting to get in - tell them straight away
  // that access is granted. This never throws (see lib/mailer.js), so a mail
  // outage can't roll back or fail an already-approved payment.
  let emailResult = { sent: false };
  if (student && student.email) {
    emailResult = await sendAccessGrantedEmail({
      to: student.email,
      name: student.name,
      subscriptionEnd: subEnd,
      method: payment.method,
      amount: payment.amount
    });
  }

  let message = 'Payment approved - the student now has 30 days of premium access.';
  if (emailResult.sent) {
    message += ` An access-granted email was sent to ${student.email}.`;
  } else if (emailResult.simulated) {
    message += ' (No email sent - SMTP is not configured. Add SMTP_HOST/SMTP_USER/SMTP_PASS to .env to enable emails.)';
  } else {
    message += ` (Email could not be sent: ${emailResult.error || 'unknown error'} - the subscription is still active.)`;
  }

  res.json({ message, emailSent: emailResult.sent });
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

  // Student counts per program/category (for the admin overview).
  const studentsByProgram = db.prepare(`
    SELECT COALESCE(p.name, u.program_code, 'Unassigned') AS program,
           COALESCE(u.program_code, 'NONE') AS code,
           COUNT(*) AS count
    FROM users u
    LEFT JOIN programs p ON p.code = u.program_code
    WHERE u.role = 'STUDENT'
    GROUP BY u.program_code
    ORDER BY count DESC
  `).all();
  const totalPrograms = db.prepare('SELECT COUNT(*) c FROM programs').get().c;
  const totalCourses = db.prepare('SELECT COUNT(*) c FROM courses').get().c;

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
    totalPrograms,
    totalCourses,
    studentsByProgram,
    byCategory,
    popular,
    mostViewed,
    recentUploads,
    recentActivity
  });
});

module.exports = router;
