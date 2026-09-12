// =============================================================================
// StudyCore — resumable upload API
// -----------------------------------------------------------------------------
// The transport half of the resumable upload feature (see lib/resumable-
// uploads.js for the reasoning and the storage layout). Content Admins and
// the Main Admin use these endpoints to push a large file up in small,
// individually-retryable chunks, then hand the finished session to the normal
// resource create/update route.
//
//   POST   /api/uploads/session            start (or look up) a session
//   GET    /api/uploads/session/:id        which chunks have landed? (resume)
//   PUT    /api/uploads/session/:id/part/:n  send one chunk
//   DELETE /api/uploads/session/:id        cancel and free the chunks
//
// Every route is authenticated and scoped to the session's owner, so one
// uploader can never inspect, extend, or cancel another's transfer.
// =============================================================================

'use strict';

const express = require('express');
const asyncHandler = require('../lib/async-handler');
const { requireAuth, requireRole } = require('../middleware/auth');
const { ROLES } = require('../lib/roles');
const { ALLOWED_EXTENSIONS, resolveMaxUploadMb } = require('../middleware/upload');
const resumable = require('../lib/resumable-uploads');
const path = require('path');

const router = express.Router();

// Uploading content is an authoring action: students never reach it.
router.use(requireAuth, requireRole(ROLES.CONTENT_ADMIN, ROLES.ADMIN));

// The same extension allowlist the multipart path enforces. Checking it at
// session creation means a rejected file type costs one small request
// instead of a whole transfer.
const MIME_TO_EXT = {
  'application/pdf': '.pdf',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/x-m4v': '.m4v',
  'video/webm': '.webm',
  'video/x-matroska': '.mkv',
  'video/x-msvideo': '.avi',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp'
};

function extensionFor(fileName, mimeType) {
  let ext = path.extname(String(fileName || '')).toLowerCase();
  if (!ext) {
    const mime = String(mimeType || '').toLowerCase().split(';')[0].trim();
    const inferred = MIME_TO_EXT[mime];
    if (inferred) ext = inferred;
  }
  return ext;
}

function sessionNotFound(res) {
  return res.status(404).json({ message: 'That upload could not be found. It may have expired — please start it again.' });
}

// ---------------------------------------------------------------------------
// Start a session
// ---------------------------------------------------------------------------
router.post('/session', asyncHandler(async (req, res) => {
  const { fileName, fileSize, mimeType, chunkSize } = req.body || {};

  const size = Number(fileSize);
  if (!Number.isFinite(size) || size <= 0) {
    return res.status(400).json({ message: 'A valid file size is required to start an upload.' });
  }

  const maxBytes = resolveMaxUploadMb() * 1024 * 1024;
  if (size > maxBytes) {
    // Rejected before a single byte moves, rather than after the uploader has
    // spent twenty minutes of mobile data discovering the limit.
    return res.status(413).json({
      message: `That file is ${(size / (1024 * 1024)).toFixed(0)}MB, which is larger than the ${resolveMaxUploadMb()}MB limit.`
    });
  }

  const ext = extensionFor(fileName, mimeType);
  if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
    return res.status(400).json({ message: `File type "${ext || 'unknown'}" is not supported.` });
  }

  const session = resumable.createSession({
    userId: req.user.id,
    fileName,
    fileSize: size,
    mimeType,
    chunkSize
  });

  return res.status(201).json({ session: resumable.describe(session) });
}));

// ---------------------------------------------------------------------------
// Resume: report exactly which chunks are already stored
// ---------------------------------------------------------------------------
router.get('/session/:id', asyncHandler(async (req, res) => {
  const session = resumable.getSession(req.params.id, req.user.id);
  if (!session) return sessionNotFound(res);
  if (resumable.isExpired(session)) {
    await resumable.discardSession(session.id).catch(() => {});
    return sessionNotFound(res);
  }
  return res.json({
    session: resumable.describe(session),
    missingParts: resumable.missingParts(session)
  });
}));

// ---------------------------------------------------------------------------
// Send one chunk
// ---------------------------------------------------------------------------
// The body is the raw chunk (application/octet-stream), NOT multipart: there
// is no reason to pay multipart framing for a single blob, and the raw stream
// pipes straight to storage.
router.put('/session/:id/part/:part', asyncHandler(async (req, res) => {
  const session = resumable.getSession(req.params.id, req.user.id);
  if (!session) return sessionNotFound(res);
  if (resumable.isExpired(session)) {
    await resumable.discardSession(session.id).catch(() => {});
    return sessionNotFound(res);
  }
  if (session.status !== 'open') {
    return res.status(409).json({ message: 'This upload has already been completed.' });
  }

  const declaredLength = req.get('Content-Length');
  const result = await resumable.putPart(
    session,
    req.params.part,
    req,
    declaredLength === undefined ? undefined : Number(declaredLength)
  );

  const fresh = resumable.getSession(session.id, req.user.id);
  return res.json({
    part: result,
    uploadedBytes: resumable.uploadedBytes(session.id),
    receivedParts: resumable.receivedPartNumbers(session.id),
    totalChunks: fresh.total_chunks
  });
}));

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------
router.delete('/session/:id', asyncHandler(async (req, res) => {
  const session = resumable.getSession(req.params.id, req.user.id);
  if (!session) return sessionNotFound(res);
  if (session.status === 'claimed') {
    return res.status(409).json({ message: 'This upload has already been published and cannot be cancelled.' });
  }
  await resumable.discardSession(session.id);
  return res.json({ cancelled: true });
}));

module.exports = router;
