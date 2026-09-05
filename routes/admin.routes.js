const express = require('express');
const asyncHandler = require('../lib/async-handler');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { upload } = require('../middleware/upload');
const storage = require('../lib/storage');
const { sendAccessGrantedEmail } = require('../lib/mailer');
const { resolveCourse, targetingForResource, validProgramCode } = require('../lib/program-access');
const { ROLES, normalizeRole, isStudent, isContentAdmin } = require('../lib/roles');
const { resourceTypeForCategory, resourceTypeLabel } = require('../lib/resource-types');

const router = express.Router();
// Main Admin only. Content Admin has its own scoped /api/content-admin routes
// and is rejected here even if it manually requests an /api/admin URL.
router.use(requireAuth, requireRole(ROLES.ADMIN));

// Keeps the Video library genuinely video-only and the Document library
// genuinely document-only - without this, nothing stops an admin from
// picking the wrong category for a file (e.g. a .pdf tagged as "video"),
// which would silently land in the wrong place with a broken player or a
// document that never streams.
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi']);
const DOCUMENT_LIKE_CATEGORIES = new Set(['document', 'tutorial', 'past_paper', 'assignment']);
const COURSE_CONTENT_CATEGORIES = new Set(['video', 'document', 'tutorial', 'past_paper']);
const VIDEO_TERMS = new Set(['Term 1', 'Term 2', 'Term 3']);

// Course content can live on a dynamic program COURSE (courseId) — the
// primary path on the multi-program platform — or on a legacy subject
// (subject), which keeps older uploads working. Content with neither is a
// general/platform resource (e.g. an all-programs "Study Skills Guide"):
// perfectly valid, it just shows up via program targeting rather than on a
// course home. Video lessons must still declare a term.
function validateCoursePlacement(category, subject, semester, courseId) {
  if (!COURSE_CONTENT_CATEGORIES.has(category)) return null;
  if (category === 'video' && !(courseId || subject)) {
    return 'Choose a program course (or subject) for every video lesson.';
  }
  if (category === 'video' && !VIDEO_TERMS.has(semester)) {
    return 'Choose Term 1, Term 2, or Term 3 for every video lesson.';
  }
  return null;
}

// Parse the admin's targeting selection into { targetAll, programCodes, error }.
//   targetAll = 'true' / 'all' / absent-with-no-programs  -> All Programs
//   programs  = comma/array of program codes, or 'ALL'
// Codes are validated against the live programs table (seed catalog PLUS any
// program Main Admin has created). A static list of the six seeded codes
// would silently drop admin-created programs — and when an entire explicit
// selection is dropped, targeting would wrongly widen to EVERY program,
// leaking program-specific content to students who should not see it.
function parseTargeting(body) {
  const rawPrograms = body.programs !== undefined ? body.programs : body.targetPrograms;
  let provided = [];
  if (Array.isArray(rawPrograms)) provided = rawPrograms;
  else if (typeof rawPrograms === 'string') provided = rawPrograms.split(',').map((s) => s.trim());
  provided = provided.map((c) => String(c).trim().toUpperCase()).filter(Boolean);

  const allFlag = body.targetAll === 'true' || body.targetAll === '1' || body.targetAll === true ||
                  body.target === 'all' || body.target === 'ALL' || provided.includes('ALL');
  const codes = [...new Set(provided.map((c) => validProgramCode(c)).filter(Boolean))];
  const targetAll = allFlag || codes.length === 0;
  // De-dupe handled above; keep only real program codes for explicit targeting.
  const programCodes = targetAll ? [] : codes;
  // An explicit selection that matches no real program is a client error —
  // refuse it rather than broadcasting the content to all programs.
  const error = provided.length > 0 && !allFlag && codes.length === 0
    ? 'None of the selected programs exist. Check the program codes and try again.'
    : null;
  return { targetAll, programCodes, error };
}

// Replace a resource's program targeting rows.
function syncResourcePrograms(resourceId, targetAll, programCodes) {
  db.prepare('DELETE FROM resource_programs WHERE resource_id = ?').run(resourceId);
  if (!targetAll) {
    const insert = db.prepare('INSERT OR IGNORE INTO resource_programs (resource_id, program_code) VALUES (?, ?)');
    for (const code of programCodes) insert.run(resourceId, code);
  }
}

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
  const targeting = targetingForResource(row);
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    subject: row.subject,
    course: row.course,
    courseId: row.course_id || null,
    targetAll: targeting.targetAll,
    targetPrograms: targeting.programs,
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
    resourceType: resourceTypeLabel(row),
    uploadedBy: row.uploaded_by || null,
    uploaderName: row.current_uploader_name || row.uploader_name || null,
    uploaderEmail: row.current_uploader_email || row.uploader_email || null,
    uploaderRole: normalizeRole(row.uploader_role || row.current_uploader_role) || null,
    uploadedAt: row.uploaded_at || row.created_at,
    downloadCount: row.download_count,
    viewCount: row.view_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function deleteFileIfExists(storedKey) {
  if (!storedKey) return;
  // Fire-and-forget - a resource row being deleted shouldn't be blocked
  // because storage was briefly slow.
  storage.deleteObject(storedKey).catch(() => {});
}

// Use the same live-user join for mutation responses as the management table.
// That makes a Content Admin's profile edits visible in Main Admin attribution
// immediately, while serializeResource still falls back to its snapshot after
// an uploader account has been deleted.
function resourceWithUploader(resourceId) {
  return db.prepare(`
    SELECT r.*, u.name AS current_uploader_name, u.email AS current_uploader_email,
           u.role AS current_uploader_role
    FROM resources r
    LEFT JOIN users u ON u.id = r.uploaded_by
    WHERE r.id = ?
  `).get(resourceId);
}

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
    newest: 'resources.created_at DESC',
    oldest: 'resources.created_at ASC',
    popular: 'resources.download_count DESC',
    title: 'resources.title ASC'
  };
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT resources.*, u.name AS current_uploader_name, u.email AS current_uploader_email, u.role AS current_uploader_role
    FROM resources
    LEFT JOIN users u ON u.id = resources.uploaded_by
    ${where}
    ORDER BY ${sortMap[sort] || sortMap.newest}
  `).all(params);
  res.json({ resources: rows.map(serializeResource) });
});

router.post('/resources', upload.single('file'), (req, res) => {
  const { title, description, category, subject, course, courseId, topic, yearLevel, semester, tags, externalUrl, quizData, dueDate, publishStatus, isPremium, pinned } = req.body;

  if (!title || !title.trim()) return res.status(400).json({ message: 'Title is required.' });
  if (!category) return res.status(400).json({ message: 'Category is required.' });

  // Resolve a dynamic program course when one is supplied.
  let courseRow = null;
  if (courseId) {
    courseRow = resolveCourse(courseId);
    if (!courseRow) return res.status(400).json({ message: 'The selected course could not be found.' });
  }
  // Default the legacy subject label from the course so the content also
  // appears correctly anywhere the subject field is still used.
  const effectiveSubject = subject || (courseRow ? courseRow.name : null);

  const placementError = validateCoursePlacement(category, effectiveSubject, semester, courseRow ? courseRow.id : null);
  if (placementError) return res.status(400).json({ message: placementError });
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
      storage.deleteObject(req.file.key).catch(() => {});
    }
    return res.status(400).json({ message: categoryMismatch });
  }

  if (quizData) {
    try { JSON.parse(quizData); } catch { return res.status(400).json({ message: 'Quiz questions must be valid JSON.' }); }
  }

  const now = new Date().toISOString();
  const uploader = db.prepare('SELECT name, email FROM users WHERE id = ?').get(req.user.id);
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

  // Program targeting (one / multiple / all programs).
  const targeting = parseTargeting(req.body);
  if (targeting.error) return res.status(400).json({ message: targeting.error });

  const row = {
    id,
    title: title.trim(),
    description: description || null,
    category,
    subject: effectiveSubject || null,
    course: course || null,
    course_id: courseRow ? courseRow.id : null,
    target_all: targeting.targetAll ? 1 : 0,
    topic: (topic || '').trim() || null,
    year_level: yearLevel || null,
    semester: semester || null,
    tags: tags || null,
    pinned: pinned === 'true' || pinned === '1' ? 1 : 0,
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
    resource_type: resourceTypeForCategory(category).label,
    uploaded_by: req.user.id,
    uploader_role: ROLES.ADMIN,
    uploader_name: uploader ? uploader.name : null,
    uploader_email: uploader ? uploader.email : null,
    uploaded_at: now,
    created_at: now,
    updated_at: now
  };

  db.prepare(`
    INSERT INTO resources (id, title, description, category, resource_type, subject, course, course_id, target_all, topic, year_level, semester, tags,
      file_name, stored_name, file_size, mime_type, content_hash, external_url, quiz_data, due_date, is_premium, pinned, publish_status,
      uploaded_by, uploader_role, uploader_name, uploader_email, uploaded_at, created_at, updated_at)
    VALUES (@id, @title, @description, @category, @resource_type, @subject, @course, @course_id, @target_all, @topic, @year_level, @semester, @tags,
      @file_name, @stored_name, @file_size, @mime_type, @content_hash, @external_url, @quiz_data, @due_date, @is_premium, @pinned, @publish_status,
      @uploaded_by, @uploader_role, @uploader_name, @uploader_email, @uploaded_at, @created_at, @updated_at)
  `).run(row);

  syncResourcePrograms(id, targeting.targetAll, targeting.programCodes);

  const saved = resourceWithUploader(id);
  const response = { resource: serializeResource(saved) };
  if (duplicateOf) {
    response.warning = `This file appears to be identical to an existing resource: "${duplicateOf.title}". Both have been kept - delete the one you don't need from the resource table below.`;
  }
  res.status(201).json(response);
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
    if (targeting.error) return res.status(400).json({ message: targeting.error });
    db.prepare('UPDATE resources SET target_all = ? WHERE id = ?').run(targeting.targetAll ? 1 : 0, existing.id);
    syncResourcePrograms(existing.id, targeting.targetAll, targeting.programCodes);
  }

  const updated = {
    id: existing.id,
    title: (title ?? existing.title).trim(),
    description: description ?? existing.description,
    category: category ?? existing.category,
    resource_type: category === undefined ? existing.resource_type : resourceTypeForCategory(category).label,
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
    UPDATE resources SET title=@title, description=@description, category=@category, resource_type=@resource_type, subject=@subject, course=@course,
      course_id=@course_id, topic=@topic, year_level=@year_level, semester=@semester, tags=@tags, external_url=@external_url,
      quiz_data=@quiz_data, due_date=@due_date, is_premium=@is_premium, pinned=@pinned, publish_status=@publish_status,
      updated_at=@updated_at, file_name=@file_name, stored_name=@stored_name, file_size=@file_size, mime_type=@mime_type,
      content_hash=@content_hash
    WHERE id=@id
  `).run(updated);

  const saved = resourceWithUploader(existing.id);
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

// Main Admin oversight for the separate Content Admin publishing role. This
// list intentionally excludes passwords and can safely be used to revoke an
// account: requireAuth re-checks `is_active` from SQLite on every request, so
// a revoked account loses access immediately even with an existing cookie.
router.get('/content-admins', (req, res) => {
  const rows = db.prepare(`
    SELECT
      u.id, u.name, u.email, u.role, u.is_active, u.created_at,
      COUNT(r.id) AS resource_count,
      SUM(CASE WHEN r.publish_status = 'published' THEN 1 ELSE 0 END) AS published_count,
      SUM(CASE WHEN r.publish_status = 'draft' THEN 1 ELSE 0 END) AS draft_count,
      MAX(COALESCE(r.uploaded_at, r.created_at)) AS last_upload_at
    FROM users u
    LEFT JOIN resources r ON r.uploaded_by = u.id
    WHERE u.role = @role
    GROUP BY u.id
    ORDER BY u.created_at DESC
  `).all({ role: ROLES.CONTENT_ADMIN });

  res.json({
    contentAdmins: rows.map((account) => ({
      id: account.id,
      name: account.name,
      email: account.email,
      role: ROLES.CONTENT_ADMIN,
      accountType: 'Content Admin',
      isActive: Number(account.is_active) !== 0,
      createdAt: account.created_at,
      resourceCount: account.resource_count || 0,
      publishedCount: account.published_count || 0,
      draftCount: account.draft_count || 0,
      lastUploadAt: account.last_upload_at || null
    }))
  });
});

router.patch('/content-admins/:id/status', (req, res) => {
  const account = db.prepare('SELECT id, name, role, is_active FROM users WHERE id = ?').get(req.params.id);
  if (!account || !isContentAdmin(account)) {
    return res.status(404).json({ message: 'Content Admin account not found.' });
  }

  const value = req.body && req.body.isActive;
  const isActiveValue = value === true || value === 1 || value === '1' || value === 'true'
    ? 1
    : (value === false || value === 0 || value === '0' || value === 'false' ? 0 : null);
  if (isActiveValue === null) {
    return res.status(400).json({ message: 'isActive must be true or false.' });
  }

  db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(isActiveValue, account.id);
  res.json({
    message: isActiveValue ? `${account.name} can use the Content Admin dashboard again.` : `${account.name}'s Content Admin access has been revoked.`,
    contentAdmin: { id: account.id, isActive: Boolean(isActiveValue) }
  });
});

// Deleting a Content Admin deliberately leaves their published resources in
// the shared library. SQLite clears the live owner reference (ON DELETE SET
// NULL) while the stored uploader snapshot preserves audit attribution; after
// deletion only Main Admin can manage those retained resources.
router.delete('/content-admins/:id', (req, res) => {
  const account = db.prepare('SELECT id, name, role, avatar_key FROM users WHERE id = ?').get(req.params.id);
  if (!account || !isContentAdmin(account)) {
    return res.status(404).json({ message: 'Content Admin account not found.' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(account.id);
  // The profile image is account-private and has no value after deletion.
  // Resource objects deliberately are not touched: their persisted uploader
  // snapshots keep Main Admin attribution intact.
  deleteFileIfExists(account.avatar_key);
  res.json({ message: `Content Admin account for ${account.name} was deleted. Existing resources were retained for Main Admin review.` });
});

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
    SELECT id, name, email, role, is_active, school, grade, learning_level, program_code, subscription, trial_end, subscription_start, subscription_end, created_at
    FROM users ${where}
    ORDER BY created_at DESC
  `).all(params);
  // Attach program display info for the management table.
  const programs = db.prepare('SELECT * FROM programs').all();
  const byCode = new Map(programs.map((p) => [p.code, p]));
  const enriched = users.map((u) => ({
    ...u,
    role: normalizeRole(u.role) || ROLES.STUDENT,
    isActive: Number(u.is_active) !== 0,
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
  if (!isStudent(user)) return res.status(400).json({ message: 'Only student accounts have a student program.' });
  const code = String((req.body && req.body.program) || '').trim().toUpperCase();
  if (!code) {
    db.prepare('UPDATE users SET program_code = NULL WHERE id = ?').run(user.id);
    return res.json({ message: 'Program cleared.' });
  }
  if (!validProgramCode(code)) {
    return res.status(400).json({ message: 'That program does not exist.' });
  }
  db.prepare('UPDATE users SET program_code = ? WHERE id = ?').run(code, user.id);
  res.json({ message: `Student's program updated to ${code}.` });
});

router.delete('/users/:id', (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ message: 'You cannot delete your own account.' });
  const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ message: 'User not found.' });
  if (!isStudent(user)) return res.status(400).json({ message: 'Only student accounts can be removed here. Use the Content Admin controls for Content Admin accounts.' });
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

router.post('/payments/:id/approve', asyncHandler(async (req, res) => {
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
  if (!payment) return res.status(404).json({ message: 'Payment request not found.' });
  if (payment.status !== 'PENDING') return res.status(400).json({ message: 'This payment has already been reviewed.' });

  const student = db.prepare('SELECT id, name, email, subscription_end FROM users WHERE id = ?').get(payment.user_id);

  const now = new Date().toISOString();
  // Extend from the student's current premium end date when it is still in
  // the future — a repeat payment must never shorten an active subscription.
  const currentEnd = student && student.subscription_end ? new Date(student.subscription_end).getTime() : 0;
  const subEnd = new Date(Math.max(Date.now(), currentEnd) + 30 * 24 * 60 * 60 * 1000).toISOString();

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
}));

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
  const totalStudents = db.prepare(`SELECT COUNT(*) c FROM users WHERE role = 'student'`).get().c;
  const premiumStudents = db.prepare(`SELECT COUNT(*) c FROM users WHERE role = 'student' AND subscription = 'premium'`).get().c;
  const totalContentAdmins = db.prepare(`SELECT COUNT(*) c FROM users WHERE role = 'content_admin'`).get().c;
  const activeContentAdmins = db.prepare(`SELECT COUNT(*) c FROM users WHERE role = 'content_admin' AND is_active = 1`).get().c;
  const totalResources = db.prepare(`SELECT COUNT(*) c FROM resources`).get().c;
  const contentAdminResources = db.prepare(`SELECT COUNT(*) c FROM resources WHERE lower(COALESCE(uploader_role, '')) = 'content_admin'`).get().c;
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
    WHERE u.role = 'student'
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
    SELECT r.id, r.title, r.category, r.resource_type, r.uploaded_at, r.created_at,
           r.uploader_role, COALESCE(u.name, r.uploader_name) AS uploader_name,
           COALESCE(u.email, r.uploader_email) AS uploader_email
    FROM resources r
    LEFT JOIN users u ON u.id = r.uploaded_by
    ORDER BY COALESCE(r.uploaded_at, r.created_at) DESC
    LIMIT 5
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
    totalContentAdmins,
    activeContentAdmins,
    contentAdminResources,
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
