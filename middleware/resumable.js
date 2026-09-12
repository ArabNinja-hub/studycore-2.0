// =============================================================================
// StudyCore — bridge between a finished resumable upload and the resource routes
// -----------------------------------------------------------------------------
// The Main Admin and Content Admin publish routes were written against
// Multer's `req.file`. Rather than fork those routes (and let the two paths
// drift apart in validation, ownership or cleanup), a completed resumable
// session is assembled into a single stored object and presented as `req.file`
// with exactly the same shape Multer produces:
//
//     { key, size, contentHash, bucket, originalname, mimetype }
//
// Everything downstream — file-type validation, duplicate detection, Cloudflare
// Stream offload, orphan cleanup on failure — therefore behaves identically
// whether the bytes arrived as one multipart POST or as forty resumable chunks.
//
// The client signals this by sending an `uploadSessionId` form field instead of
// a `file` part.
// =============================================================================

'use strict';

const resumable = require('../lib/resumable-uploads');
const { matchesSignature } = require('./upload');

// Runs AFTER the multipart parser, so req.body is populated either way.
function attachResumableUpload(req, res, next) {
  const sessionId = req.body && (req.body.uploadSessionId || req.body.upload_session_id);
  if (!sessionId) return next();

  // A request that somehow carries both a multipart file and a session is
  // ambiguous. Prefer the streamed file and release the session's chunks so
  // they cannot linger in the bucket.
  if (req.file) {
    resumable.discardSession(sessionId).catch(() => {});
    return next();
  }

  const session = resumable.getSession(sessionId, req.user.id);
  if (!session) {
    return res.status(404).json({
      message: 'That upload could not be found. It may have expired — please choose the file again.'
    });
  }

  // An already-claimed session means the publish request was retried after the
  // response was lost (a very common mobile failure). Re-using the object it
  // already produced makes the retry idempotent instead of creating a
  // duplicate resource from a second copy of the same bytes.
  if (session.status === 'claimed' && session.storage_key) {
    req.file = {
      key: session.storage_key,
      size: session.file_size,
      contentHash: null,
      bucket: null,
      originalname: session.file_name,
      mimetype: session.mime_type,
      resumable: true,
      alreadyClaimed: true
    };
    return next();
  }

  Promise.resolve()
    .then(async () => {
      if (session.status === 'complete' && session.storage_key) {
        // Assembled by an earlier attempt whose response never arrived.
        return {
          key: session.storage_key,
          size: session.file_size,
          contentHash: null,
          bucket: null,
          originalname: session.file_name,
          mimetype: session.mime_type,
          resumable: true
        };
      }
      return resumable.finalizeSession(session, { validateHead: matchesSignature });
    })
    .then((file) => {
      req.file = file;
      req.uploadSessionId = session.id;
      next();
    })
    .catch((err) => {
      if (err && err.missingParts) {
        return res.status(409).json({
          message: 'This upload is not finished yet. StudyCore will send the remaining parts.',
          missingParts: err.missingParts
        });
      }
      next(err);
    });
}

// Called by a route once the resource row referencing the assembled object has
// been committed, so the expiry sweeper never deletes an object that is now
// live content.
function claimResumableUpload(req) {
  if (req && req.uploadSessionId) {
    try { resumable.markClaimed(req.uploadSessionId); } catch { /* best effort */ }
  }
}

module.exports = { attachResumableUpload, claimResumableUpload };
