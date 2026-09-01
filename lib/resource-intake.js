// =============================================
// STUDYCORE — Resource intake (lib/resource-intake.js)
// -----------------------------------------------
// The single source of truth for "an upload becomes a resource row".
//
// Two surfaces create resources:
//   1. the full admin dashboard   (/api/admin/resources)
//   2. the code-gated upload portal (/api/upload-portal/resources)
//
// Both must validate placement, category/file agreement and program
// targeting identically — so all of that lives here instead of being
// duplicated (and eventually drifting) between the two routers.
// =============================================

const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const storage = require('./storage');
const { VALID_PROGRAM_CODES } = require('./programs');
const { resolveCourse, targetingForResource } = require('./program-access');

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

// Parse the admin's targeting selection into { targetAll, programCodes }.
//   targetAll = 'true' / 'all' / absent-with-no-programs  -> All Programs
//   programs  = comma/array of program codes, or 'ALL'
function parseTargeting(body) {
  const rawPrograms = body.programs !== undefined ? body.programs : body.targetPrograms;
  let codes = [];
  if (Array.isArray(rawPrograms)) codes = rawPrograms;
  else if (typeof rawPrograms === 'string') codes = rawPrograms.split(',').map((s) => s.trim());
  codes = codes.map((c) => String(c).toUpperCase()).filter((c) => VALID_PROGRAM_CODES.has(c));

  const allFlag = body.targetAll === 'true' || body.targetAll === '1' || body.targetAll === true ||
                  body.target === 'all' || body.target === 'ALL';
  const targetAll = allFlag || codes.includes('ALL') || codes.length === 0;
  // De-dupe and keep only valid codes for explicit targeting.
  const programCodes = targetAll ? [] : [...new Set(codes)].filter((c) => c !== 'ALL');
  return { targetAll, programCodes };
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

// ---------------------------------------------------------------------------
// createResource({ body, file, uploaderId })
//
// Validates and inserts a single resource. Returns { status, body } so the
// caller (any router) can just forward it: res.status(status).json(body).
// Any file already streamed to storage is cleaned up when validation fails,
// so a rejected upload never leaves an orphaned object behind.
// ---------------------------------------------------------------------------
function createResource({ body = {}, file = null, uploaderId = null }) {
  const {
    title, description, category, subject, course, courseId, topic, yearLevel,
    semester, tags, externalUrl, quizData, dueDate, publishStatus, isPremium, pinned
  } = body;

  const fail = (status, message) => {
    // Multer has already streamed the file to storage by the time we get
    // here - drop it rather than leaving an object with no resource row.
    if (file && file.key) storage.deleteObject(file.key).catch(() => {});
    return { status, body: { message } };
  };

  if (!title || !title.trim()) return fail(400, 'Title is required.');
  if (!category) return fail(400, 'Category is required.');

  // Resolve a dynamic program course when one is supplied.
  let courseRow = null;
  if (courseId) {
    courseRow = resolveCourse(courseId);
    if (!courseRow) return fail(400, 'The selected course could not be found.');
  }
  // Default the legacy subject label from the course so the content also
  // appears correctly anywhere the subject field is still used.
  const effectiveSubject = subject || (courseRow ? courseRow.name : null);

  const placementError = validateCoursePlacement(category, effectiveSubject, semester, courseRow ? courseRow.id : null);
  if (placementError) return fail(400, placementError);
  if (category === 'quiz' && !quizData) return fail(400, 'Quiz questions (JSON) are required for quizzes.');
  if (category === 'video' && !file) {
    // Videos are watch-on-site only, uploaded and streamed like Netflix -
    // never a link out to YouTube or anywhere else, so a real file is
    // mandatory here rather than optional.
    return fail(400, 'Please upload an actual video file - external video links are no longer supported.');
  }

  const categoryMismatch = validateFileMatchesCategory(category, file);
  if (categoryMismatch) return fail(400, categoryMismatch);

  if (quizData) {
    try { JSON.parse(quizData); } catch { return fail(400, 'Quiz questions must be valid JSON.'); }
  }

  const now = new Date().toISOString();
  const id = `res-${uuidv4()}`;
  let contentHash = null;
  let duplicateOf = null;

  if (file) {
    contentHash = file.contentHash;
    const existingDuplicate = db.prepare(`
      SELECT id, title FROM resources WHERE content_hash = ? AND id != ? LIMIT 1
    `).get(contentHash, id);
    if (existingDuplicate) duplicateOf = existingDuplicate;
  }

  // Program targeting (one / multiple / all programs).
  const targeting = parseTargeting(body);

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
    file_name: file ? file.originalname : null,
    stored_name: file ? file.key : null,
    file_size: file ? file.size : null,
    mime_type: file ? file.mimetype : null,
    content_hash: contentHash,
    external_url: category === 'video' ? null : (externalUrl || null),
    quiz_data: quizData || null,
    due_date: dueDate || null,
    is_premium: isPremium === 'false' || isPremium === '0' ? 0 : 1,
    publish_status: publishStatus || 'published',
    uploaded_by: uploaderId,
    created_at: now,
    updated_at: now
  };

  db.prepare(`
    INSERT INTO resources (id, title, description, category, subject, course, course_id, target_all, topic, year_level, semester, tags,
      file_name, stored_name, file_size, mime_type, content_hash, external_url, quiz_data, due_date, is_premium, pinned, publish_status, uploaded_by, created_at, updated_at)
    VALUES (@id, @title, @description, @category, @subject, @course, @course_id, @target_all, @topic, @year_level, @semester, @tags,
      @file_name, @stored_name, @file_size, @mime_type, @content_hash, @external_url, @quiz_data, @due_date, @is_premium, @pinned, @publish_status, @uploaded_by, @created_at, @updated_at)
  `).run(row);

  syncResourcePrograms(id, targeting.targetAll, targeting.programCodes);

  const saved = db.prepare('SELECT * FROM resources WHERE id = ?').get(id);
  const payload = { resource: serializeResource(saved) };
  if (duplicateOf) {
    payload.warning = `This file appears to be identical to an existing resource: "${duplicateOf.title}". Both have been kept - delete the one you don't need from the resource table below.`;
  }
  return { status: 201, body: payload };
}

module.exports = {
  VIDEO_EXTENSIONS,
  DOCUMENT_LIKE_CATEGORIES,
  COURSE_CONTENT_CATEGORIES,
  VIDEO_TERMS,
  validateCoursePlacement,
  parseTargeting,
  syncResourcePrograms,
  validateFileMatchesCategory,
  serializeResource,
  deleteFileIfExists,
  createResource
};
