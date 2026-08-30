const path = require('path');
const { Readable } = require('stream');
const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth, COOKIE_NAME } = require('../middleware/auth');
const storage = require('../lib/storage');
const { programCanSeeResource, resourceVisibilityClause, resolveCourse } = require('../lib/program-access');

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
    courseId: row.course_id || null,
    topic: row.topic || null,
    yearLevel: row.year_level,
    semester: row.semester,
    tags: row.tags ? row.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
    fileName: row.file_name,
    fileSize: row.file_size,
    mimeType: row.stored_name ? inferMime(row) : row.mime_type,
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

// Streams a stored object (Cloudflare R2, or the local-disk fallback) without
// buffering the file. HTTP Range is parsed and honored so video seeking and
// progressive PDF rendering can start on the first chunk.
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
  '.wav': 'audio/wav',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel'
};

const EXT_BY_MIME = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-excel': '.xls'
};

function inferMime(row) {
  const given = String(row.mime_type || '').trim().toLowerCase().split(';')[0].trim();
  // Prefer an original-name extension, then the storage-key extension. The
  // latter repairs legacy mobile uploads whose original name was a bare UUID
  // but whose stored key received the extension inferred during upload.
  const originalExt = path.extname(String(row.file_name || '')).toLowerCase();
  const storedExt = path.extname(String(row.stored_name || '')).toLowerCase();
  if (MIME_BY_EXT[originalExt]) return MIME_BY_EXT[originalExt];
  if (MIME_BY_EXT[storedExt]) return MIME_BY_EXT[storedExt];
  if (given && given !== 'application/octet-stream' && given !== 'binary/octet-stream') {
    return given;
  }
  // Truly ambiguous legacy files are identified from a tiny range read in
  // resolveType rather than forcing the reader down the wrong code path.
  return given || 'application/octet-stream';
}

function sniffMime(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'application/pdf';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4';
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'video/webm';
  // Office Open XML (Word / PowerPoint / Excel) files are ZIP containers.
  // Mobile browsers frequently upload them as bare UUIDs or octet-stream, so
  // sniffing the container is the only reliable way to learn the real type.
  // The first local file header carries the entry name at offset 30 — for
  // .docx/.pptx/.xlsx archives that name always starts with "word/", "ppt/"
  // or "xl/" (or "[Content_Types].xml" when the archive is alphabetised), so
  // scanning the early bytes for those markers is cheap and authoritative.
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    const head = buf.toString('latin1', 0, Math.min(buf.length, 8192));
    // The full part names are always referenced by [Content_Types].xml, which
    // word processors place among the first entries of the archive, so a
    // short read is enough to tell a .docx from a .pptx from a plain .zip.
    if (head.includes('word/document.xml')) {
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    }
    if (head.includes('ppt/presentation.xml')) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    if (head.includes('xl/workbook.xml')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    return 'application/zip';
  }
  return null;
}

function parseRange(header, size) {
  if (!header) return null;
  const m = String(header).trim().match(/^bytes=(\d*)-(\d*)$/i);
  if (!m) return { unsatisfiable: true };
  let start;
  let end;
  if (m[1] === '' && m[2] !== '') {
    const suffix = Number(m[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) return { unsatisfiable: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else if (m[1] !== '') {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Number(m[2]);
  } else {
    return { unsatisfiable: true };
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || (size > 0 && start >= size) || end < start) {
    return { unsatisfiable: true };
  }
  if (size === 0) return null;
  return { start, end: Math.min(end, size - 1) };
}

function ensureFileNameWithExt(filename, mimeType, key) {
  let raw = String(filename || key || 'file').replace(/[\r\n"]/g, '').trim();
  if (!raw) raw = 'file';
  const ext = path.extname(raw).toLowerCase();
  const mime = String(mimeType || '').toLowerCase().split(';')[0].trim();
  // If filename has no extension but we know it's a PDF (or image/video),
  // append the proper extension so Android's "Open with" dialog and the
  // doc reader's type sniffing both see a real file name.
  if (!ext) {
    const inferredExt = EXT_BY_MIME[mime];
    if (inferredExt) {
      raw = raw + inferredExt;
    } else if (mime === 'application/pdf' || mime === '') {
      // Default bare names (UUIDs) to .pdf when we have no better info —
      // PDFs are the overwhelming majority of documents in StudyCore.
      // The Content-Type header still carries the true type.
      const maybePdf = String(filename || '').match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      if (maybePdf || !mime || mime === 'application/octet-stream') {
        // Only auto-append .pdf if the underlying key or sniff suggests PDF
        // — we do that check in resolveType, but as a safe fallback here we
        // append .pdf for bare UUIDs, which were the reported crash case.
        if (maybePdf) raw = raw + '.pdf';
      }
    }
  }
  // If the filename is a bare UUID (the reported bug), make it more
  // readable by prefixing "document-" but keep the UUID for uniqueness.
  // This prevents Android from showing "Open with 9735a310-..." with no
  // context.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.pdf)?$/i.test(raw)) {
    raw = raw.toLowerCase().endsWith('.pdf') ? raw : raw + '.pdf';
    // Keep as is but ensure it has .pdf — the UI title is separate.
  }
  return raw;
}

function inlineContentDisposition(filename, key, mimeType) {
  const raw = ensureFileNameWithExt(filename, mimeType, key);
  const encoded = encodeURIComponent(raw);
  return `inline; filename="${raw}"; filename*=UTF-8''${encoded}`;
}

function pipeBodyToResponse(body, res, req) {
  if (!body) {
    if (!res.writableEnded) res.end();
    return;
  }
  const fail = () => {
    if (!res.headersSent) res.status(500);
    if (!res.writableEnded) res.end();
  };
  let nodeStream = null;
  if (typeof body.pipe === 'function') {
    nodeStream = body;
  } else if (typeof Readable.fromWeb === 'function' && typeof body.getReader === 'function') {
    nodeStream = Readable.fromWeb(body);
  }
  if (!nodeStream) {
    fail();
    return;
  }
  const abort = () => {
    if (!res.writableEnded && typeof nodeStream.destroy === 'function') nodeStream.destroy();
  };
  // Do not listen to IncomingMessage "close" here. On current Node versions
  // it fires when the request message is complete (which is immediately for a
  // GET), not only when the phone disconnects. Destroying the storage stream
  // at that point produced empty/truncated PDFs most often on slower Android
  // and iOS connections. "aborted" is the actual request-abort signal; the
  // response close check covers a client leaving during the stream.
  if (req) req.once('aborted', abort);
  res.once('close', () => {
    if (!res.writableEnded) abort();
  });
  nodeStream.on('error', fail);
  nodeStream.pipe(res);
}

function r2StreamError(err, res) {
  if (err.code === 'NoSuchKey' || err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
    return res.status(404).json({ message: 'File is missing from storage.' });
  }
  console.error('Storage stream error:', err.message);
  return res.status(502).json({ message: 'Could not reach file storage. Please try again shortly.' });
}

async function resolveType(key, storedType, fallbackType) {
  // Always try to sniff the real file type first — stored metadata can be
  // wrong when a file was uploaded without an extension (mobile browsers
  // sometimes send application/octet-stream for a PDF named as a UUID).
  // Sniffing is cheap (first 16 bytes, 8KB for ZIP containers so Office
  // part names are visible) and authoritative.
  try {
    const first = await storage.readBytes(key, 0, 15);
    const isZip = first.length >= 4 && first[0] === 0x50 && first[1] === 0x4b && first[2] === 0x03 && first[3] === 0x04;
    const head = isZip ? await storage.readBytes(key, 0, 8191) : first;
    const sniffed = sniffMime(head);
    if (sniffed) return sniffed;
  } catch {
    // If we can't read the file, fall through to metadata.
  }
  const stored = String(storedType || '').trim().toLowerCase().split(';')[0].trim();
  if (stored && stored !== 'application/octet-stream' && stored !== 'binary/octet-stream' && stored !== '') return stored;
  const given = String(fallbackType || '').trim().toLowerCase().split(';')[0].trim();
  if (given && given !== 'application/octet-stream' && given !== 'binary/octet-stream' && given !== '') return given;
  // Last resort: if filename has a known extension, use that.
  return given || stored || 'application/octet-stream';
}

function isSpecificMime(value) {
  const type = String(value || '').trim().toLowerCase().split(';')[0].trim();
  return Boolean(type && type !== 'application/octet-stream' && type !== 'binary/octet-stream');
}

async function streamStoredObject(req, res, key, { filename, mimeType, fileSize }) {
  // The database already stores the exact upload size and normalized type.
  // Use those values for GET/range requests so every 128 KB PDF chunk maps to
  // one storage request rather than HEAD + signature probe + GET. Keep the
  // slower storage lookup for HEAD requests and ambiguous legacy records.
  const hasKnownSize = fileSize !== null && fileSize !== undefined &&
    Number.isFinite(Number(fileSize)) && Number(fileSize) >= 0;
  let size = hasKnownSize ? Number(fileSize) : 0;
  let storedType = null;

  if (req.method === 'HEAD' || !hasKnownSize) {
    let meta;
    try {
      meta = await storage.headObject(key);
    } catch (err) {
      return r2StreamError(err, res);
    }
    size = Number(meta.contentLength) || 0;
    storedType = meta.contentType;
  }

  const type = isSpecificMime(mimeType)
    ? String(mimeType).trim().toLowerCase().split(';')[0].trim()
    : await resolveType(key, storedType, mimeType);
  const range = parseRange(req.headers.range, size);

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', type);
  // Ensure the filename sent to the browser always has an extension so
  // mobile OS "Open with" dialogs show something sensible and the doc
  // reader's type detection works even when the original upload had a bare
  // UUID name.
  const safeFilename = ensureFileNameWithExt(filename, type, key);
  res.setHeader('Content-Disposition', inlineContentDisposition(safeFilename, key, type));
  // Private cache lets the browser reuse range chunks while seeking / paging
  // a PDF. The URL is still session-gated — unauthenticated clients cannot
  // hit this route at all.
  res.setHeader('Cache-Control', 'private, max-age=120, no-transform');
  res.setHeader('X-Robots-Tag', 'noindex, noarchive, nosnippet');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (range && range.unsatisfiable) {
    res.setHeader('Content-Range', `bytes */${size}`);
    return res.status(416).end();
  }

  if (req.method === 'HEAD') {
    if (range) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
      res.setHeader('Content-Length', String(range.end - range.start + 1));
    } else {
      res.status(200);
      res.setHeader('Content-Length', String(size));
    }
    return res.end();
  }

  let object;
  try {
    object = await storage.getObject(key, range || undefined);
  } catch (err) {
    return r2StreamError(err, res);
  }

  if (range) {
    res.status(206);
    res.setHeader('Content-Range', object.contentRange || `bytes ${range.start}-${range.end}/${size}`);
    res.setHeader('Content-Length', String(object.contentLength != null ? object.contentLength : (range.end - range.start + 1)));
  } else {
    res.status(200);
    res.setHeader('Content-Length', String(object.contentLength != null ? object.contentLength : size));
  }

  pipeBodyToResponse(object.body, res, req);
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
  const { category, excludeCategory, subject, course, courseId, topic, year, semester, search, sort = 'newest', page = 1, pageSize = 24 } = req.query;

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
  // Program-course filter: courseId accepts the course id, code or slug so the
  // resources page can narrow to a real program course even when its `course`
  // text field is empty.
  if (courseId) {
    const courseRow = resolveCourse(courseId);
    if (!courseRow) return res.status(404).json({ message: 'Course not found.' });
    clauses.push('course_id = @courseId');
    params.courseId = courseRow.id;
  }
  if (topic) { clauses.push('LOWER(topic) = LOWER(@topic)'); params.topic = topic; }
  if (year) { clauses.push('year_level = @year'); params.year = year; }
  if (semester) { clauses.push('semester = @semester'); params.semester = semester; }
  if (search) {
    clauses.push('(title LIKE @search OR description LIKE @search OR subject LIKE @search OR tags LIKE @search OR topic LIKE @search)');
    params.search = `%${search}%`;
  }

  // Program-based visibility: students only ever receive resources targeted
  // at (a) all programs or (b) their own program / courses. Enforced in SQL
  // so unauthorized rows never leave the database.
  const vis = resourceVisibilityClause(req.user, 'resources');
  if (vis.clause) clauses.push(vis.clause);
  Object.assign(params, vis.params);

  const sortMap = {
    newest: 'created_at DESC',
    oldest: 'created_at ASC',
    popular: 'view_count DESC',
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
      completed: db.prepare('SELECT 1 AS x FROM lesson_progress WHERE user_id = ? AND resource_id = ?').get(req.user.id, row.id) ? true : false,
      isRead: row.category === 'announcement' ? Boolean(db.prepare('SELECT 1 FROM announcement_reads WHERE user_id = ? AND announcement_id = ?').get(req.user.id, row.id)) : undefined
    })),
    total,
    page: Number(page),
    pageSize: limit,
    access: { premium: req.access.premium, trial: req.access.trial }
  });
});

async function handleStream(req, res) {
  const row = db.prepare(`SELECT * FROM resources WHERE id = ? AND publish_status = 'published'`).get(req.params.id);
  if (!row) return res.status(404).json({ message: 'Resource not found.' });
  // Program permission (Student → Program → Course → Resource) is checked
  // before any subscription gating — a Law student streaming a Mines
  // resource id is refused outright.
  if (!programCanSeeResource(req.user, row)) return res.status(403).json({ message: 'This content is not available for your program.' });
  if (!canAccess(row, req.access)) return lockedResponse(res, lockReason(row, req.access));
  if (!row.stored_name && !row.external_url) return res.status(404).json({ message: 'This resource has no previewable file.' });
  if (row.external_url) return res.status(404).json({ message: 'This resource has no previewable file.' });
  await streamStoredObject(req, res, row.stored_name, {
    filename: row.file_name || row.stored_name,
    mimeType: inferMime(row),
    fileSize: row.file_size
  });
}

router.head('/:id/stream', requireAuth, gate, handleStream);
router.get('/:id/stream', requireAuth, gate, handleStream);

// ---- Video playback progress (server-stored resume position) ---------------
//
// Only Premium-authorized video playback may read or write progress: the
// resume position of a protected video is itself protected content, so a
// trial/expired student querying it gets the same 403 as the stream.

router.post('/:id/video-progress', requireAuth, gate, (req, res) => {
  const row = db.prepare(`SELECT * FROM resources WHERE id = ? AND publish_status = 'published'`).get(req.params.id);
  if (!row || row.category !== 'video') return res.status(404).json({ message: 'Video lesson not found.' });
  if (!programCanSeeResource(req.user, row)) return res.status(403).json({ message: 'This content is not available for your program.' });
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
  if (!programCanSeeResource(req.user, row)) return res.status(403).json({ message: 'This content is not available for your program.' });
  if (!canAccess(row, req.access)) return lockedResponse(res, 'video');

  const saved = db.prepare('SELECT position, duration, updated_at FROM video_progress WHERE user_id = ? AND resource_id = ?').get(req.user.id, row.id);
  res.json({ position: saved ? saved.position : 0, duration: saved ? saved.duration : 0, updatedAt: saved ? saved.updated_at : null });
});

router.get('/bookmarks/mine', requireAuth, gate, (req, res) => {
  const vis = resourceVisibilityClause(req.user, 'r', 'bmProgram');
  const rows = db.prepare(`
    SELECT r.* FROM bookmarks b
    JOIN resources r ON r.id = b.resource_id
    WHERE b.user_id = @userId AND r.publish_status = 'published'
    ${vis.clause ? `AND ${vis.clause}` : ''}
    ORDER BY b.created_at DESC
  `).all({ userId: req.user.id, ...vis.params });
  res.json({ resources: rows.map((r) => ({ ...serializeResource(r), locked: canAccess(r, req.access) ? null : lockReason(r, req.access) })) });
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

  // 1) Courses. Logged-in students get the dynamic catalog for their
  // program; anonymous visitors get the legacy public subject directory.
  let courses;
  if (user && user.role !== 'ADMIN' && user.program_code) {
    const programCourses = db.prepare(`
      SELECT c.code, c.name, c.slug
      FROM program_courses pc
      JOIN courses c ON c.id = pc.course_id
      WHERE pc.program_code = ?
      ORDER BY pc.sort_order ASC, c.code ASC
    `).all(user.program_code);
    courses = programCourses
      .filter((c) => c.name.toLowerCase().includes(q.toLowerCase()) || c.code.toLowerCase().includes(q.toLowerCase()))
      .map((c) => ({ slug: c.slug, subject: `${c.code} — ${c.name}`, code: c.code, programCourse: true }));
  } else {
    courses = COURSE_SUBJECTS.filter((c) => c.subject.toLowerCase().includes(q.toLowerCase()))
      .map((c) => ({ slug: c.slug, subject: c.subject }));
  }

  // 2) Topics (names only - public structure). Program students only get
  // topics from content they can see.
  const vis = user
    ? resourceVisibilityClause(user, 'resources', 'searchProgram')
    : { clause: "target_all = 1", params: {} };
  const topicRows = db.prepare(`
    SELECT DISTINCT resources.topic, resources.subject, c.code AS course_code, c.slug AS course_slug
    FROM resources
    LEFT JOIN courses c ON c.id = resources.course_id
    WHERE resources.publish_status = 'published' AND resources.topic IS NOT NULL AND resources.topic != ''
      ${vis.clause ? `AND ${vis.clause}` : ''}
    ORDER BY resources.topic ASC
  `).all({ ...vis.params });
  const topics = topicRows
    .filter((t) => t.topic.toLowerCase().includes(q.toLowerCase()) || (t.subject || '').toLowerCase().includes(q.toLowerCase()))
    .slice(0, limit)
    .map((t) => ({
      topic: t.topic,
      subject: t.subject,
      slug: t.course_slug || COURSE_SUBJECTS.find((c) => c.subject === t.subject)?.slug || '',
      courseCode: t.course_code || null,
      courseSlug: t.course_slug || null,
      programCourse: Boolean(t.course_slug)
    }));

  // 3) Content (only for logged-in students, permission-flagged).
  let results = [];
  if (user) {
    const contentVis = resourceVisibilityClause(user, 'resources', 'searchProgram');
    const rows = db.prepare(`
      SELECT resources.*, c.code AS course_code, c.slug AS course_slug
      FROM resources
      LEFT JOIN courses c ON c.id = resources.course_id
      WHERE resources.publish_status = 'published'
        AND resources.category NOT IN ('announcement', 'quiz', 'assignment')
        ${contentVis.clause ? `AND ${contentVis.clause}` : ''}
        AND (resources.title LIKE @q OR resources.description LIKE @q OR resources.topic LIKE @q OR resources.tags LIKE @q OR resources.subject LIKE @q)
      ORDER BY
        CASE resources.category WHEN 'video' THEN 0 WHEN 'document' THEN 1 WHEN 'tutorial' THEN 2 ELSE 3 END,
        resources.created_at DESC
      LIMIT @limit
    `).all({ q: ql, limit, ...contentVis.params });

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
      courseId: row.course_id || null,
      courseCode: row.course_code || null,
      courseSlug: row.course_slug || null,
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
  if (!programCanSeeResource(req.user, row)) return res.status(403).json({ message: 'This content is not available for your program.' });
  if (!canAccess(row, req.access)) return lockedResponse(res, lockReason(row, req.access));
  db.prepare('UPDATE resources SET view_count = view_count + 1 WHERE id = ?').run(row.id);

  if (row.category === 'announcement' && req.user) {
    try {
      db.prepare(`
        INSERT INTO announcement_reads (id, user_id, announcement_id, read_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, announcement_id) DO NOTHING
      `).run(`ar-${uuidv4()}`, req.user.id, row.id, new Date().toISOString());
    } catch {
      // ignore
    }
  }

  res.json({
    resource: {
      ...serializeResource(row),
      isRead: row.category === 'announcement' ? true : undefined
    }
  });
});

// Documents and videos are view-only. Keep an explicit denial at the former
// URL so saved links cannot bypass the reader after the UI control is gone.
router.get('/:id/download', requireAuth, (req, res) => {
  res.status(403).json({
    message: 'Downloads are disabled. Open this resource in the StudyCore reader instead.'
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
