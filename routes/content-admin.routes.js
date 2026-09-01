// =============================================
// StudyCore Content Admin API
// ---------------------------------------------
// This is intentionally separate from /api/admin. Content Admins get a
// tightly-scoped workflow for their own educational uploads only; Main Admin
// endpoints, users, payments, analytics and platform configuration remain
// protected by the admin role in routes/admin.routes.js.
// =============================================

const path = require('path');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { upload } = require('../middleware/upload');
const storage = require('../lib/storage');
const { ROLES } = require('../lib/roles');
const { resolveCourse, programIncludesCourse } = require('../lib/program-access');
const {
  CONTENT_RESOURCE_TYPES,
  normalizeResourceType,
  resourceTypeLabel
} = require('../lib/resource-types');

const router = express.Router();
router.use(requireAuth, requireRole(ROLES.CONTENT_ADMIN));

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi']);
const VIDEO_TERMS = new Set(['Term 1', 'Term 2', 'Term 3']);
const PUBLISH_STATUSES = new Set(['published', 'draft']);

function cleanText(value, maxLength = 0) {
  const text = typeof value === 'string' ? value.trim() : '';
  return maxLength ? text.slice(0, maxLength) : text;
}

function cleanupIncomingFile(req) {
  if (req && req.file && req.file.key) storage.deleteObject(req.file.key).catch(() => {});
}

function uploadError(req, res, status, message) {
  cleanupIncomingFile(req);
  return res.status(status).json({ message });
}

function resourcePrograms(row) {
  return String(row.target_program_codes || '')
    .split(',')
    .map((code) => code.trim())
    .filter(Boolean);
}

function serializeOwnResource(row) {
  const programCodes = resourcePrograms(row);
  return {
    id: row.id,
    title: row.title,
    description: row.description || '',
    category: row.category,
    resourceType: resourceTypeLabel(row),
    resourceTypeKey: normalizeResourceType(row.resource_type)?.key || null,
    schoolFaculty: row.program_name || null,
    programCode: programCodes[0] || null,
    programCodes,
    courseId: row.course_id || null,
    courseCode: row.course_code || null,
    courseName: row.course_name || row.course || row.subject || null,
    topic: row.topic || '',
    yearLevel: row.year_level || '',
    semester: row.semester || '',
    fileName: row.file_name || '',
    fileSize: row.file_size || 0,
    mimeType: row.mime_type || '',
    hasFile: Boolean(row.stored_name),
    publishStatus: row.publish_status,
    uploadedAt: row.uploaded_at || row.created_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const OWN_RESOURCE_SELECT = `
  SELECT r.*, c.code AS course_code, c.name AS course_name,
         p.name AS program_name,
         GROUP_CONCAT(rp.program_code) AS target_program_codes
  FROM resources r
  LEFT JOIN courses c ON c.id = r.course_id
  LEFT JOIN resource_programs rp ON rp.resource_id = r.id
  LEFT JOIN programs p ON p.code = rp.program_code
`;

function ownResourceById(resourceId, userId) {
  return db.prepare(`${OWN_RESOURCE_SELECT}
    WHERE r.id = ? AND r.uploaded_by = ?
    GROUP BY r.id
  `).get(resourceId, userId);
}

function ownResources(userId, { limit = 200 } = {}) {
  return db.prepare(`${OWN_RESOURCE_SELECT}
    WHERE r.uploaded_by = ?
    GROUP BY r.id
    ORDER BY COALESCE(r.uploaded_at, r.created_at) DESC
    LIMIT ?
  `).all(userId, limit);
}

function currentProgramForResource(resourceId) {
  const row = db.prepare(`
    SELECT program_code FROM resource_programs
    WHERE resource_id = ?
    ORDER BY program_code ASC
    LIMIT 1
  `).get(resourceId);
  return row ? row.program_code : null;
}

function validateFileForType(type, file) {
  if (!file) return 'Choose a file to upload.';
  const originalExt = path.extname(String(file.originalname || '')).toLowerCase();
  // Multer's storage adapter exposes a newly-uploaded object as `key`, while
  // an existing database row uses `stored_name`. Support both so a mobile
  // picker that supplies a UUID-only filename can still use its inferred
  // storage extension (for example, .mp4) during Content Admin validation.
  const storedExt = path.extname(String(file.stored_name || file.key || '')).toLowerCase();
  const ext = originalExt || storedExt;
  if (type.category === 'video' && !VIDEO_EXTENSIONS.has(ext)) {
    return 'Video resources must use a supported video file (.mp4, .mov, .webm, .mkv, or .avi).';
  }
  if (type.category !== 'video' && VIDEO_EXTENSIONS.has(ext)) {
    return 'Video files must be uploaded with the Video resource type.';
  }
  return null;
}

function validatePlacement({ programCode, courseId, topic, type, semester }) {
  if (!programCode) return { error: 'Select a school or faculty.' };
  const program = db.prepare('SELECT code, name FROM programs WHERE code = ?').get(programCode);
  if (!program) return { error: 'The selected school or faculty could not be found.' };

  if (!courseId) return { error: 'Select a course.' };
  const course = resolveCourse(courseId);
  if (!course) return { error: 'The selected course could not be found.' };
  if (!programIncludesCourse(program.code, course.id)) {
    return { error: 'That course is not part of the selected school or faculty.' };
  }

  if (!topic) return { error: 'Select or enter a topic.' };
  if (type.category === 'video' && !VIDEO_TERMS.has(semester)) {
    return { error: 'Choose Term 1, Term 2, or Term 3 for a video resource.' };
  }
  return { program, course };
}

function replaceSingleProgram(resourceId, programCode) {
  db.prepare('DELETE FROM resource_programs WHERE resource_id = ?').run(resourceId);
  db.prepare('INSERT INTO resource_programs (resource_id, program_code) VALUES (?, ?)')
    .run(resourceId, programCode);
}

function parseResourceInput(body, existing = null, existingProgramCode = null) {
  const source = body || {};
  const requestedProgram = source.programCode ?? source.schoolFaculty ?? source.school ?? source.faculty;
  const programCode = requestedProgram === undefined
    ? existingProgramCode
    : cleanText(requestedProgram, 32).toUpperCase();
  const courseId = source.courseId === undefined
    ? (existing ? existing.course_id : '')
    : cleanText(source.courseId, 160);
  const topic = source.topic === undefined
    ? cleanText(existing && existing.topic, 120)
    : cleanText(source.topic, 120);
  const title = source.title === undefined
    ? cleanText(existing && existing.title, 180)
    : cleanText(source.title, 180);
  const description = source.description === undefined
    ? (existing && existing.description ? String(existing.description).slice(0, 5000) : '')
    : cleanText(source.description, 5000);
  const resourceTypeValue = source.resourceType === undefined
    ? (existing && existing.resource_type ? existing.resource_type : (existing && existing.category))
    : source.resourceType;
  const type = normalizeResourceType(resourceTypeValue) ||
    // Existing Main Admin rows can have labels such as "Document". For an
    // owned Content Admin row this is only a migration fallback.
    (existing ? Object.values(CONTENT_RESOURCE_TYPES).find((item) => item.category === existing.category) : null);
  const semester = source.semester === undefined
    ? cleanText(existing && existing.semester, 24)
    : cleanText(source.semester, 24);
  const yearLevel = source.yearLevel === undefined
    ? cleanText(existing && existing.year_level, 80)
    : cleanText(source.yearLevel, 80);
  const requestedStatus = source.publishStatus === undefined
    ? (existing ? existing.publish_status : 'published')
    : cleanText(source.publishStatus, 24).toLowerCase();

  if (!title) return { error: 'Resource title is required.' };
  if (!type) return { error: 'Choose a valid resource type.' };
  if (!PUBLISH_STATUSES.has(requestedStatus)) return { error: 'Choose a valid publication status.' };

  const placement = validatePlacement({ programCode, courseId, topic, type, semester });
  if (placement.error) return { error: placement.error };

  return {
    value: {
      title,
      description: description || null,
      type,
      program: placement.program,
      course: placement.course,
      topic,
      semester: semester || null,
      yearLevel: yearLevel || null,
      publishStatus: requestedStatus
    }
  };
}

// The Content Admin's own dashboard data. The profile is re-read from SQLite
// so an updated name always comes back as the authenticated account's real
// name, not a browser-cached or hard-coded placeholder.
router.get('/dashboard', (req, res) => {
  const user = db.prepare(`
    SELECT id, name, email, role, avatar_key, created_at
    FROM users WHERE id = ?
  `).get(req.user.id);
  if (!user) return res.status(404).json({ message: 'User not found.' });

  const summary = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN publish_status = 'published' THEN 1 ELSE 0 END) AS published,
      SUM(CASE WHEN publish_status = 'draft' THEN 1 ELSE 0 END) AS drafts
    FROM resources
    WHERE uploaded_by = ?
  `).get(user.id);

  const recent = ownResources(user.id, { limit: 5 }).map(serializeOwnResource);
  res.json({
    profile: {
      name: user.name,
      email: user.email,
      role: ROLES.CONTENT_ADMIN,
      accountType: 'Content Admin',
      hasAvatar: Boolean(user.avatar_key),
      createdAt: user.created_at
    },
    summary: {
      total: summary.total || 0,
      published: summary.published || 0,
      drafts: summary.drafts || 0
    },
    recentUploads: recent
  });
});

// A safe catalog for the limited uploader. It contains only school/faculty,
// course and topic structure — not the Main Admin program-management API.
router.get('/catalog', (req, res) => {
  const programs = db.prepare('SELECT code, name, short_name, group_name, icon FROM programs ORDER BY rowid ASC').all()
    .map((program) => ({
      code: program.code,
      name: program.name,
      shortName: program.short_name || program.name,
      groupName: program.group_name || null,
      icon: program.icon || 'book-open',
      courses: db.prepare(`
        SELECT c.id, c.code, c.slug, c.name, c.icon, c.subject
        FROM program_courses pc
        JOIN courses c ON c.id = pc.course_id
        WHERE pc.program_code = ?
        ORDER BY pc.sort_order ASC, c.code ASC
      `).all(program.code).map((course) => ({
        id: course.id,
        code: course.code,
        slug: course.slug,
        name: course.name,
        icon: course.icon || 'book-open',
        subject: course.subject || null
      }))
    }));

  const topics = db.prepare(`
    SELECT DISTINCT course_id, topic
    FROM resources
    WHERE topic IS NOT NULL AND trim(topic) != '' AND course_id IS NOT NULL
    ORDER BY topic COLLATE NOCASE ASC
  `).all().map((row) => ({ courseId: row.course_id, topic: row.topic }));

  res.json({ programs, topics });
});

// Content Admins can see only the resources where they are the stored
// uploader. This WHERE clause is also repeated on single-resource edit/delete
// actions; client-side filtering is never an authorization boundary.
router.get('/resources', (req, res) => {
  const rows = ownResources(req.user.id);
  res.json({ resources: rows.map(serializeOwnResource) });
});

router.get('/resources/:id', (req, res) => {
  const row = ownResourceById(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ message: 'Resource not found.' });
  res.json({ resource: serializeOwnResource(row) });
});

router.post('/resources', upload.single('file'), (req, res) => {
  if (!req.file) return uploadError(req, res, 400, 'Choose a file to upload.');
  const parsed = parseResourceInput(req.body);
  if (parsed.error) return uploadError(req, res, 400, parsed.error);

  const fileError = validateFileForType(parsed.value.type, req.file);
  if (fileError) return uploadError(req, res, 400, fileError);

  const now = new Date().toISOString();
  const uploader = db.prepare('SELECT name, email FROM users WHERE id = ?').get(req.user.id);
  const id = `res-${uuidv4()}`;
  const row = {
    id,
    title: parsed.value.title,
    description: parsed.value.description,
    category: parsed.value.type.category,
    resource_type: parsed.value.type.label,
    subject: parsed.value.course.name,
    course: parsed.value.course.code,
    course_id: parsed.value.course.id,
    target_all: 0,
    topic: parsed.value.topic,
    year_level: parsed.value.yearLevel,
    semester: parsed.value.semester,
    tags: null,
    file_name: req.file.originalname,
    stored_name: req.file.key,
    file_size: req.file.size,
    mime_type: req.file.mimetype,
    content_hash: req.file.contentHash || null,
    external_url: null,
    quiz_data: null,
    due_date: null,
    is_premium: 1,
    pinned: 0,
    publish_status: parsed.value.publishStatus,
    uploaded_by: req.user.id,
    uploader_role: ROLES.CONTENT_ADMIN,
    uploader_name: uploader ? uploader.name : null,
    uploader_email: uploader ? uploader.email : null,
    uploaded_at: now,
    created_at: now,
    updated_at: now
  };

  try {
    db.exec('BEGIN');
    db.prepare(`
      INSERT INTO resources (
        id, title, description, category, resource_type, subject, course, course_id,
        target_all, topic, year_level, semester, tags, file_name, stored_name,
        file_size, mime_type, content_hash, external_url, quiz_data, due_date,
        is_premium, pinned, publish_status, uploaded_by, uploader_role,
        uploader_name, uploader_email, uploaded_at, created_at, updated_at
      ) VALUES (
        @id, @title, @description, @category, @resource_type, @subject, @course, @course_id,
        @target_all, @topic, @year_level, @semester, @tags, @file_name, @stored_name,
        @file_size, @mime_type, @content_hash, @external_url, @quiz_data, @due_date,
        @is_premium, @pinned, @publish_status, @uploaded_by, @uploader_role,
        @uploader_name, @uploader_email, @uploaded_at, @created_at, @updated_at
      )
    `).run(row);
    replaceSingleProgram(id, parsed.value.program.code);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* no open transaction */ }
    cleanupIncomingFile(req);
    console.error('Content Admin resource create failed:', err.message);
    return res.status(500).json({ message: 'Could not publish the resource. Please try again.' });
  }

  const saved = ownResourceById(id, req.user.id);
  return res.status(201).json({ resource: serializeOwnResource(saved) });
});

router.put('/resources/:id', upload.single('file'), (req, res) => {
  const existing = ownResourceById(req.params.id, req.user.id);
  if (!existing) {
    cleanupIncomingFile(req);
    // Do not reveal whether another Content Admin owns this id.
    return res.status(404).json({ message: 'Resource not found.' });
  }

  const existingProgramCode = currentProgramForResource(existing.id);
  const parsed = parseResourceInput(req.body, existing, existingProgramCode);
  if (parsed.error) return uploadError(req, res, 400, parsed.error);

  const fileForValidation = req.file || {
    originalname: existing.file_name,
    stored_name: existing.stored_name,
    mimetype: existing.mime_type
  };
  const fileError = validateFileForType(parsed.value.type, fileForValidation);
  if (fileError) return uploadError(req, res, 400, fileError);

  const replacingFile = Boolean(req.file);
  const now = new Date().toISOString();
  const updated = {
    id: existing.id,
    title: parsed.value.title,
    description: parsed.value.description,
    category: parsed.value.type.category,
    resource_type: parsed.value.type.label,
    subject: parsed.value.course.name,
    course: parsed.value.course.code,
    course_id: parsed.value.course.id,
    topic: parsed.value.topic,
    year_level: parsed.value.yearLevel,
    semester: parsed.value.semester,
    publish_status: parsed.value.publishStatus,
    updated_at: now,
    file_name: replacingFile ? req.file.originalname : existing.file_name,
    stored_name: replacingFile ? req.file.key : existing.stored_name,
    file_size: replacingFile ? req.file.size : existing.file_size,
    mime_type: replacingFile ? req.file.mimetype : existing.mime_type,
    content_hash: replacingFile ? (req.file.contentHash || null) : existing.content_hash,
    owner_id: req.user.id
  };

  try {
    db.exec('BEGIN');
    const updateResult = db.prepare(`
      UPDATE resources SET
        title = @title, description = @description, category = @category,
        resource_type = @resource_type, subject = @subject, course = @course,
        course_id = @course_id, topic = @topic, year_level = @year_level,
        semester = @semester, publish_status = @publish_status,
        updated_at = @updated_at, file_name = @file_name,
        stored_name = @stored_name, file_size = @file_size,
        mime_type = @mime_type, content_hash = @content_hash,
        target_all = 0
      WHERE id = @id AND uploaded_by = @owner_id
    `).run(updated);
    if (updateResult.changes !== 1) {
      const ownershipError = new Error('Resource not found.');
      ownershipError.statusCode = 404;
      throw ownershipError;
    }
    replaceSingleProgram(existing.id, parsed.value.program.code);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* no open transaction */ }
    cleanupIncomingFile(req);
    if (err.statusCode === 404) return res.status(404).json({ message: 'Resource not found.' });
    console.error('Content Admin resource update failed:', err.message);
    return res.status(500).json({ message: 'Could not save the resource. Please try again.' });
  }

  if (replacingFile && existing.stored_name && existing.stored_name !== req.file.key) {
    storage.deleteObject(existing.stored_name).catch(() => {});
  }

  const saved = ownResourceById(existing.id, req.user.id);
  return res.json({ resource: serializeOwnResource(saved) });
});

router.delete('/resources/:id', (req, res) => {
  const existing = ownResourceById(req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ message: 'Resource not found.' });

  try {
    const deleteResult = db.prepare('DELETE FROM resources WHERE id = ? AND uploaded_by = ?').run(existing.id, req.user.id);
    if (deleteResult.changes !== 1) return res.status(404).json({ message: 'Resource not found.' });
  } catch (err) {
    console.error('Content Admin resource delete failed:', err.message);
    return res.status(500).json({ message: 'Could not delete the resource. Please try again.' });
  }
  if (existing.stored_name) storage.deleteObject(existing.stored_name).catch(() => {});
  return res.json({ message: 'Resource deleted.' });
});

module.exports = router;
