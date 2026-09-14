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
const asyncHandler = require('../lib/async-handler');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { upload } = require('../middleware/upload');
const { attachResumableUpload, claimResumableUpload } = require('../middleware/resumable');
const resumableUploads = require('../lib/resumable-uploads');
const storage = require('../lib/document-storage');
const stream = require('../lib/stream');
const googleDrive = require('../lib/google-drive');
const { ROLES } = require('../lib/roles');
const { resolveCourse, programIncludesCourse, programOwnsCourse } = require('../lib/program-access');
const { validateLabReportPlacement } = require('../lib/lab-reports');
const accessPolicy = require('../lib/access-policy');
const {
  TERMS,
  normalizeTerm,
  termAppliesTo,
  termRequiredFor,
  termRequiredMessage
} = require('../lib/terms');
const { sharedProgramCodes, isShareableCourse, sharingNoticeFor } = require('../lib/program-sharing');
const {
  CONTENT_RESOURCE_TYPES,
  normalizeResourceType,
  resourceTypeLabel
} = require('../lib/resource-types');

const router = express.Router();
router.use(requireAuth, requireRole(ROLES.CONTENT_ADMIN));

const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi']);
const VIDEO_TERMS = new Set(TERMS);
const PUBLISH_STATUSES = new Set(['published', 'draft']);

function conditionalUpload(req, res, next) {
  // Always use Multer's single-file parser so multipart form fields
  // (including hidden Google Drive inputs) are properly parsed into
  // req.body regardless of whether a file is attached.
  //
  // attachResumableUpload then runs second: when the form carries an
  // `uploadSessionId` instead of a `file` part, the already-transferred
  // chunks are assembled into one stored object and exposed as `req.file`.
  // Everything below this point cannot tell the two paths apart.
  return upload.single('file')(req, res, (err) => {
    if (err) return next(err);
    return attachResumableUpload(req, res, next);
  });
}

function cleanText(value, maxLength = 0) {
  const text = typeof value === 'string' ? value.trim() : '';
  return maxLength ? text.slice(0, maxLength) : text;
}

function cleanupIncomingFile(req) {
  const file = req && req.file;
  if (!file) return;
  if (file.streamUid) stream.deleteVideo(file.streamUid).catch(() => {});
  // A Drive-hosted reference owns no StudyCore object, and the file in Google
  // Drive belongs to the uploader — abandoning a publish must never delete it.
  else if (file.key && file.bucket !== 'google_drive') storage.deleteObject(file.key, file.bucket).catch(() => {});
  if (req.uploadSessionId) resumableUploads.discardSession(req.uploadSessionId).catch(() => {});
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
  // Pooled schools that also receive this upload. Empty unless the resource
  // targets a pooled program AND sits on a shareable course, so the uploader
  // is never told Biology or Engineering Drawing is being shared.
  const shareable = !row.course_id || isShareableCourse({
    id: row.course_id,
    code: row.course_code,
    name: row.course_name,
    subject: row.subject
  });
  const alsoVisibleTo = shareable
    ? [...new Set(programCodes.flatMap((code) => sharedProgramCodes(code)))]
      .filter((code) => !programCodes.includes(code))
    : [];
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
    alsoVisibleTo,
    isPremium: Boolean(row.is_premium),
    term: row.semester || null,
    courseId: row.course_id || null,
    courseCode: row.course_code || null,
    courseName: row.course_name || row.course || row.subject || null,
    topic: row.topic || '',
    yearLevel: row.year_level || '',
    semester: row.semester || '',
    fileName: row.file_name || '',
    fileSize: row.file_size || 0,
    mimeType: row.mime_type || '',
    hasFile: Boolean(row.stored_name || row.google_drive_file_id || row.stream_uid),
    storageProvider: row.storage_provider || 'local',
    googleDriveFileId: row.google_drive_file_id || null,
    googleDriveUrl: row.google_drive_url || null,
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
  const ext = originalExt || storedExt || (String(file.mimetype || '').toLowerCase().startsWith('video/') ? '.mp4' : '');
  if (type.category === 'video' && !VIDEO_EXTENSIONS.has(ext)) {
    return 'Video resources must use a supported video file (.mp4, .m4v, .mov, .webm, .mkv, or .avi).';
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
  // programIncludesCourse accepts a course taught by a pooled partner school
  // (School of Mines ↔ Non-Quota), which is exactly what lets one upload
  // serve both. Biology and Engineering Drawing are excluded inside the
  // sharing library, so they can still only be published by their own school.
  if (!programIncludesCourse(program.code, course.id)) {
    return { error: 'That course is not part of the selected school or faculty.' };
  }

  if (!topic) return { error: 'Select or enter a topic.' };
  if (type.category === 'video' && !VIDEO_TERMS.has(normalizeTerm(semester))) {
    return { error: 'Choose Term 1, Term 2, or Term 3 for a video resource.' };
  }
  // Notes, tutorial sheets and past papers are shelved by term on the course
  // page, so the term is required for them too. Lab reports are exempt.
  if (termRequiredFor(type.category, { courseId: course.id }) && !normalizeTerm(semester)) {
    return { error: termRequiredMessage(type.label) };
  }
  if (type.category === 'lab_report') {
    const labError = validateLabReportPlacement([program.code], course);
    if (labError) return { error: labError };
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
      // Canonical term label, or NULL for categories that carry no term.
      semester: termAppliesTo(type.category) ? normalizeTerm(semester) : null,
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
//
// Pooled schools (School of Mines ↔ Non-Quota) list each other's shareable
// courses as well, each tagged with `sharedFrom` and `sharedWith`, so the
// uploader can see at a glance that one upload reaches both. Biology and
// Engineering Drawing are never pooled and stay under their own school only.
router.get('/catalog', (req, res) => {
  const programRows = db.prepare('SELECT code, name, short_name, group_name, icon FROM programs ORDER BY rowid ASC').all();
  const nameByCode = Object.fromEntries(programRows.map((p) => [p.code, p.short_name || p.name]));
  const coursesFor = (code) => db.prepare(`
    SELECT c.id, c.code, c.slug, c.name, c.icon, c.subject
    FROM program_courses pc
    JOIN courses c ON c.id = pc.course_id
    WHERE pc.program_code = ?
    ORDER BY pc.sort_order ASC, c.code ASC
  `).all(code);

  const programs = programRows.map((program) => {
    const peers = sharedProgramCodes(program.code);
    const own = coursesFor(program.code).map((course) => ({
      id: course.id,
      code: course.code,
      slug: course.slug,
      name: course.name,
      icon: course.icon || 'book-open',
      subject: course.subject || null,
      sharedFrom: null,
      // Which other schools will also receive content published here.
      sharedWith: isShareableCourse(course) ? peers : []
    }));

    const seen = new Set(own.map((course) => course.id));
    const shared = [];
    for (const peer of peers) {
      for (const course of coursesFor(peer)) {
        if (seen.has(course.id) || !isShareableCourse(course)) continue;
        seen.add(course.id);
        shared.push({
          id: course.id,
          code: course.code,
          slug: course.slug,
          name: course.name,
          icon: course.icon || 'book-open',
          subject: course.subject || null,
          sharedFrom: peer,
          sharedWith: [peer]
        });
      }
    }

    return {
      code: program.code,
      name: program.name,
      shortName: program.short_name || program.name,
      groupName: program.group_name || null,
      icon: program.icon || 'book-open',
      sharesWith: peers,
      sharingNotice: sharingNoticeFor(program.code, nameByCode),
      courses: [...own, ...shared]
    };
  });

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

router.post('/resources', conditionalUpload, asyncHandler(async (req, res) => {
  const isDriveFile = Boolean(req.body && req.body.google_drive_file_id);
  if (!req.file && !isDriveFile) return uploadError(req, res, 400, 'Choose a file to upload or select from Google Drive.');
  const parsed = parseResourceInput(req.body);
  if (parsed.error) return uploadError(req, res, 400, parsed.error);
  if (isDriveFile && parsed.value.type.category === 'video') {
    return uploadError(req, res, 400, 'Video lessons must be uploaded to Bunny Stream, not selected from Google Drive.');
  }

  // GOOGLE DRIVE IS THE STORAGE. A Drive selection is REFERENCED, never
  // copied: the bytes stay in Google Drive and StudyCore records the file id.
  // Students read it through the protected /stream endpoint, which fetches it
  // from Drive server-side — they never touch Google's permission system and
  // are never redirected to drive.google.com. See lib/google-drive.js.
  let driveLink = null;
  if (isDriveFile && !req.file) {
    try {
      driveLink = await googleDrive.linkDriveFile({
        fileId: req.body.google_drive_file_id,
        accessToken: req.body.google_drive_access_token,
        fileName: req.body.file_name || req.body.google_drive_file_name,
        mimeType: req.body.mime_type || req.body.google_drive_mime_type
      });
    } catch (err) {
      return uploadError(req, res, err.statusCode || 502, err.message);
    }
    req.file = driveLink;
  }

  const fileError = validateFileForType(parsed.value.type, req.file);
  if (fileError) {
    cleanupIncomingFile(req);
    return uploadError(req, res, 400, fileError);
  }

  const now = new Date().toISOString();
  const uploader = db.prepare('SELECT name, email FROM users WHERE id = ?').get(req.user.id);
  const id = `res-${uuidv4()}`;

  const fileName = req.file.originalname;
  const storedName = req.file.key || null;
  const fileSizeVal = req.file.size;
  const mimeTypeVal = req.file.mimetype;
  const contentHashVal = req.file.contentHash || null;

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
    file_name: fileName,
    stored_name: storedName,
    file_size: fileSizeVal,
    mime_type: mimeTypeVal,
    content_hash: contentHashVal,
    // A Drive-hosted document is not an "external link" resource: StudyCore
    // serves it from its own viewer, so external_url stays empty.
    external_url: isDriveFile ? null : (req.body.external_url || null),
    quiz_data: null,
    due_date: null,
    // Platform policy decides this, not the uploader: past papers, notes and
    // tutorial sheets publish as free; lab reports publish as premium.
    is_premium: accessPolicy.resolvePremiumFlag(parsed.value.type.category, undefined),
    pinned: 0,
    publish_status: parsed.value.publishStatus,
    uploaded_by: req.user.id,
    uploader_role: ROLES.CONTENT_ADMIN,
    uploader_name: uploader ? uploader.name : null,
    uploader_email: uploader ? uploader.email : null,
    uploaded_at: now,
    created_at: now,
    updated_at: now,
    // Where the bytes ACTUALLY live. 'google_drive' means Google Drive is the
    // storage and every read is fetched from there on demand; 'r2'/'local'/
    // 'google_drive_vault' mean a direct upload landed in that backend.
    storage_provider: req.file.bucket || storage.backendName(),
    stream_uid: req.file.streamUid || null,
    stream_status: req.file.streamStatus || null,
    stream_duration: req.file.streamDuration || null,
    // For a Drive-hosted document this id is the AUTHORITATIVE reference the
    // stream route resolves to fetch the file from Google Drive. The URL is
    // provenance only and is never sent to a student.
    google_drive_file_id: isDriveFile ? (req.body.google_drive_file_id || null) : null,
    google_drive_url: isDriveFile ? (req.body.google_drive_url || null) : null
  };

  try {
    db.exec('BEGIN');
    db.prepare(`
      INSERT INTO resources (
        id, title, description, category, resource_type, subject, course, course_id,
        target_all, topic, year_level, semester, tags, file_name, stored_name,
        file_size, mime_type, content_hash, external_url, quiz_data, due_date,
        is_premium, pinned, publish_status, uploaded_by, uploader_role,
        uploader_name, uploader_email, uploaded_at, created_at, updated_at,
        storage_provider, google_drive_file_id, google_drive_url, stream_uid, stream_status, stream_duration
      ) VALUES (
        @id, @title, @description, @category, @resource_type, @subject, @course, @course_id,
        @target_all, @topic, @year_level, @semester, @tags, @file_name, @stored_name,
        @file_size, @mime_type, @content_hash, @external_url, @quiz_data, @due_date,
        @is_premium, @pinned, @publish_status, @uploaded_by, @uploader_role,
        @uploader_name, @uploader_email, @uploaded_at, @created_at, @updated_at,
        @storage_provider, @google_drive_file_id, @google_drive_url, @stream_uid, @stream_status, @stream_duration
      )
    `).run({ ...row, storage_provider: row.storage_provider, google_drive_file_id: row.google_drive_file_id, google_drive_url: row.google_drive_url });
    replaceSingleProgram(id, parsed.value.program.code);
    db.exec('COMMIT');
    // The assembled object is now referenced by a committed row, so the
    // resumable sweeper must never reclaim it.
    claimResumableUpload(req);
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* no open transaction */ }
    cleanupIncomingFile(req);
    console.error('Content Admin resource create failed:', err.message);
    return res.status(500).json({ message: 'Could not publish the resource. Please try again.' });
  }

  // Bunny accepted the complete upload before this resource was committed.

  const saved = ownResourceById(id, req.user.id);
  return res.status(201).json({ resource: serializeOwnResource(saved) });
}));

router.put('/resources/:id', conditionalUpload, asyncHandler(async (req, res) => {
  const existing = ownResourceById(req.params.id, req.user.id);
  if (!existing) {
    cleanupIncomingFile(req);
    // Do not reveal whether another Content Admin owns this id.
    return res.status(404).json({ message: 'Resource not found.' });
  }

  const existingProgramCode = currentProgramForResource(existing.id);
  const parsed = parseResourceInput(req.body, existing, existingProgramCode);
  if (parsed.error) return uploadError(req, res, 400, parsed.error);

  const isDriveFile = Boolean(req.body && req.body.google_drive_file_id);
  if (isDriveFile && parsed.value.type.category === 'video') {
    return uploadError(req, res, 400, 'Video lessons must be uploaded to Bunny Stream, not selected from Google Drive.');
  }

  // Picking a (new) Drive file while editing references it, exactly like
  // publish — the bytes stay in Google Drive. A token is only present when the
  // Picker actually ran in this submission, so re-saving an unchanged resource
  // does not re-verify it against Drive.
  const relinkingDrive = isDriveFile && !req.file &&
    Boolean(req.body.google_drive_access_token) &&
    req.body.google_drive_file_id !== existing.google_drive_file_id;
  if (relinkingDrive) {
    try {
      req.file = await googleDrive.linkDriveFile({
        fileId: req.body.google_drive_file_id,
        accessToken: req.body.google_drive_access_token,
        fileName: req.body.file_name || req.body.google_drive_file_name,
        mimeType: req.body.mime_type || req.body.google_drive_mime_type
      });
    } catch (err) {
      return uploadError(req, res, err.statusCode || 502, err.message);
    }
  }

  const fileForValidation = req.file || {
    originalname: existing.file_name,
    // A Drive-hosted row's stored_name is a Drive file id, not a filename, so
    // it must not be mined for an extension during type validation.
    stored_name: (existing.storage_provider || 'local') === 'google_drive' ? null : existing.stored_name,
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
    // Switching an upload's type (e.g. Past Paper → Lab Report) must move it
    // to the right side of the paywall immediately.
    is_premium: accessPolicy.resolvePremiumFlag(
      parsed.value.type.category,
      undefined,
      existing.is_premium
    ),
    publish_status: parsed.value.publishStatus,
    updated_at: now,
    // `replacingFile` covers a newly referenced Drive file too. For those the
    // "storage key" written to stored_name is the Google Drive FILE ID, which
    // is exactly what the stream route resolves to fetch the document back out
    // of Drive (storage_provider = 'google_drive' below selects that path).
    file_name: replacingFile ? req.file.originalname : existing.file_name,
    stored_name: replacingFile ? (req.file.key || null) : existing.stored_name,
    file_size: replacingFile ? req.file.size : existing.file_size,
    mime_type: replacingFile ? req.file.mimetype : existing.mime_type,
    content_hash: replacingFile ? (req.file.contentHash || null) : existing.content_hash,
    // Replacing the file invalidates any Stream video encoded from the old
    // bytes; clear the fields (and delete the old Stream video below) so a
    // fresh offload can run. Otherwise carry the existing Stream fields.
    stream_uid: replacingFile ? (req.file.streamUid || null) : (existing.stream_uid || null),
    stream_status: replacingFile ? (req.file.streamStatus || null) : (existing.stream_status || null),
    stream_duration: replacingFile ? (req.file.streamDuration || null) : (existing.stream_duration || null),
    owner_id: req.user.id,
    storage_provider: replacingFile
      ? (req.file.bucket || storage.backendName())
      : (existing.storage_provider || 'local'),
    google_drive_file_id: (req.body.google_drive_file_id !== undefined)
      ? (req.body.google_drive_file_id || null)
      : (existing.google_drive_file_id || null),
    google_drive_url: (req.body.google_drive_file_id !== undefined)
      ? (req.body.google_drive_url || null)
      : (existing.google_drive_url || null)
  };

  try {
    db.exec('BEGIN');
    const updateResult = db.prepare(`
      UPDATE resources SET
        title = @title, description = @description, category = @category,
        resource_type = @resource_type, subject = @subject, course = @course,
        course_id = @course_id, topic = @topic, year_level = @year_level,
        semester = @semester, is_premium = @is_premium,
        publish_status = @publish_status,
        updated_at = @updated_at, file_name = @file_name,
        stored_name = @stored_name, file_size = @file_size,
        mime_type = @mime_type, content_hash = @content_hash,
        storage_provider = @storage_provider,
        stream_uid = @stream_uid, stream_status = @stream_status, stream_duration = @stream_duration,
        google_drive_file_id = @google_drive_file_id,
        google_drive_url = @google_drive_url,
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
    claimResumableUpload(req);
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* no open transaction */ }
    cleanupIncomingFile(req);
    if (err.statusCode === 404) return res.status(404).json({ message: 'Resource not found.' });
    console.error('Content Admin resource update failed:', err.message);
    return res.status(500).json({ message: 'Could not save the resource. Please try again.' });
  }

  // Drive-hosted rows reference a file that LIVES in the uploader's Google
  // Drive. Swapping the resource to a different file must never delete the
  // previous document out of Drive — StudyCore only ever drops its reference.
  const hadStoredObject = existing.stored_name &&
    (existing.storage_provider || 'local') !== 'google_drive';
  if (replacingFile && hadStoredObject && existing.stored_name !== req.file.key) {
    storage.deleteObject(existing.stored_name, existing.storage_provider).catch(() => {});
  }
  // The old Bunny video is removed only after the row safely references the
  // replacement that Bunny accepted.
  if (replacingFile && existing.stream_uid && existing.stream_uid !== req.file.streamUid) {
    stream.deleteVideo(existing.stream_uid).catch(() => {});
  }

  const saved = ownResourceById(existing.id, req.user.id);
  return res.json({ resource: serializeOwnResource(saved) });
}));

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
  // Drive-hosted rows only REFERENCE a file in Google Drive; the document
  // belongs to its owner there. Deleting the StudyCore resource removes the
  // reference and must never delete the file out of Google Drive.
  if (existing.stored_name && (existing.storage_provider || 'local') !== 'google_drive') {
    storage.deleteObject(existing.stored_name, existing.storage_provider).catch(() => {});
  }
  if (existing.stream_uid) stream.deleteVideo(existing.stream_uid).catch(() => {});
  return res.json({ message: 'Resource deleted.' });
});

module.exports = router;
