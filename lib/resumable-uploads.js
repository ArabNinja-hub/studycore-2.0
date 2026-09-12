// =============================================================================
// StudyCore — resumable chunked uploads
// -----------------------------------------------------------------------------
// WHY THIS EXISTS
//
// Every upload used to be one long multipart POST. On the connections our
// uploaders actually have (mobile data, intermittent WiFi, a phone that locks
// its screen after 30 seconds) that is the wrong shape entirely:
//
//   · The browser suspends an in-flight XHR when the page is backgrounded or
//     the screen turns off, so the socket dies mid-transfer.
//   · A WiFi -> mobile-data handover changes the source address and kills the
//     connection.
//   · Any of these threw away 100% of the bytes already transferred. A 300MB
//     lecture video at 90% became 0%, repeatedly, forever.
//
// So an upload is now a SESSION made of small, individually-retryable chunks:
//
//   1. POST   /api/uploads/session          -> create a session, get its id
//   2. PUT    /api/uploads/session/:id/part/:n  -> send one chunk (repeat)
//   3. GET    /api/uploads/session/:id      -> which chunks landed? (resume)
//   4. The resource route "claims" the finished session instead of a multipart
//      file, assembling the chunks into one stored object.
//
// Because the manifest lives in SQLite rather than process memory, a resumed
// upload works across a server restart, a redeploy, or a different instance
// reading the same database — the browser just asks which parts are missing
// and sends only those.
//
// STORAGE LAYOUT
//   Chunks are written as ordinary objects under `uploads-tmp/<sessionId>/<n>`
//   through lib/storage, so they inherit the same R2-or-local-disk behaviour
//   as finished resources. On completion they are streamed back in order into
//   the final object and then deleted. Nothing is ever buffered whole in
//   memory: assembly is a sequential stream, exactly like the old multipart
//   path, and R2's multipart uploader still handles the outbound leg.
// =============================================================================

'use strict';

const path = require('path');
const crypto = require('crypto');
const { Readable, PassThrough } = require('stream');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const storage = require('./storage');

const TMP_PREFIX = 'uploads-tmp';

// A chunk is deliberately small enough to complete inside one screen-on
// window on a slow uplink, and large enough that per-request overhead stays
// negligible. 5MB at 200kbps is ~3.5 minutes, which a backgrounded tab can
// usually still finish; anything bigger starts losing whole chunks to
// suspension. The client may request a different size within these bounds
// (e.g. a smaller one after repeated failures).
const DEFAULT_CHUNK_SIZE = 5 * 1024 * 1024;
const MIN_CHUNK_SIZE = 256 * 1024;
const MAX_CHUNK_SIZE = 16 * 1024 * 1024;

// How long a half-finished upload is kept. Someone who starts a big upload on
// the bus and finishes it at home that evening must still be able to resume,
// so this is generous — but not unbounded, or abandoned sessions would leak
// objects in the bucket forever. The sweeper below removes expired sessions
// and their chunks.
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

// A single user cannot hold open an unlimited number of sessions: that would
// be an easy way to park arbitrary bytes in the bucket. Creating one past the
// cap evicts that user's oldest session.
const MAX_OPEN_SESSIONS_PER_USER = 12;

function nowIso() {
  return new Date().toISOString();
}

function partKey(sessionId, partNumber) {
  return `${TMP_PREFIX}/${sessionId}/${partNumber}`;
}

function resolveChunkSize(requested) {
  const value = Number(requested);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_CHUNK_SIZE;
  return Math.min(MAX_CHUNK_SIZE, Math.max(MIN_CHUNK_SIZE, Math.floor(value)));
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

function getSession(sessionId, userId) {
  if (!sessionId) return null;
  // Ownership is part of the lookup, never a later check: one uploader must
  // never be able to read, extend or claim another uploader's session.
  return db.prepare(`
    SELECT * FROM upload_sessions WHERE id = ? AND user_id = ?
  `).get(String(sessionId), String(userId)) || null;
}

function receivedParts(sessionId) {
  return db.prepare(`
    SELECT part_number, size FROM upload_session_parts
    WHERE session_id = ? ORDER BY part_number ASC
  `).all(String(sessionId));
}

function receivedPartNumbers(sessionId) {
  return receivedParts(sessionId).map((row) => row.part_number);
}

function uploadedBytes(sessionId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(size), 0) AS total FROM upload_session_parts WHERE session_id = ?
  `).get(String(sessionId));
  return Number(row && row.total) || 0;
}

function isExpired(session) {
  return !session || Date.parse(session.expires_at) <= Date.now();
}

function createSession({ userId, fileName, fileSize, mimeType, chunkSize }) {
  const size = Number(fileSize);
  if (!Number.isFinite(size) || size <= 0) {
    const err = new Error('A valid file size is required to start an upload.');
    err.statusCode = 400;
    err.userSafe = true;
    throw err;
  }

  const resolvedChunk = resolveChunkSize(chunkSize);
  const totalChunks = Math.ceil(size / resolvedChunk);
  const id = `up-${uuidv4()}`;
  const created = nowIso();

  pruneUserSessions(userId);

  db.prepare(`
    INSERT INTO upload_sessions (
      id, user_id, file_name, file_size, mime_type, chunk_size, total_chunks,
      storage_key, status, created_at, updated_at, expires_at
    ) VALUES (
      @id, @user_id, @file_name, @file_size, @mime_type, @chunk_size, @total_chunks,
      NULL, 'open', @created_at, @created_at, @expires_at
    )
  `).run({
    id,
    user_id: String(userId),
    file_name: String(fileName || 'upload').slice(0, 255),
    file_size: size,
    mime_type: String(mimeType || 'application/octet-stream').slice(0, 255),
    chunk_size: resolvedChunk,
    total_chunks: totalChunks,
    created_at: created,
    expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString()
  });

  return db.prepare('SELECT * FROM upload_sessions WHERE id = ?').get(id);
}

// Keep one uploader's open sessions bounded. The oldest are discarded with
// their chunks, so a user who abandons uploads cannot accumulate storage.
function pruneUserSessions(userId) {
  const open = db.prepare(`
    SELECT id FROM upload_sessions
    WHERE user_id = ? AND status = 'open'
    ORDER BY created_at DESC
  `).all(String(userId));
  const excess = open.slice(MAX_OPEN_SESSIONS_PER_USER - 1);
  for (const row of excess) discardSession(row.id).catch(() => {});
}

function touchSession(sessionId) {
  db.prepare(`
    UPDATE upload_sessions SET updated_at = ?, expires_at = ? WHERE id = ?
  `).run(nowIso(), new Date(Date.now() + SESSION_TTL_MS).toISOString(), String(sessionId));
}

// ---------------------------------------------------------------------------
// Receiving one chunk
// ---------------------------------------------------------------------------

// `body` is the raw request stream for this chunk. It is piped straight to
// storage — the process never holds a whole chunk, let alone a whole file.
//
// Re-sending a chunk that already landed is explicitly allowed and is a
// no-op-with-overwrite: after a dropped connection the client cannot know
// whether the last in-flight chunk was committed, so it re-sends and we
// simply overwrite. This idempotency is what makes resume safe.
async function putPart(session, partNumber, body, declaredLength) {
  const index = Number(partNumber);
  if (!Number.isInteger(index) || index < 0 || index >= session.total_chunks) {
    const err = new Error('That upload chunk is outside the range of this upload.');
    err.statusCode = 400;
    err.userSafe = true;
    throw err;
  }

  // Every chunk is exactly chunk_size except the last, which is the
  // remainder. Enforcing this means a malformed or hostile client cannot
  // make the assembled object differ in length from the size it declared.
  const isLast = index === session.total_chunks - 1;
  const expected = isLast
    ? session.file_size - (session.chunk_size * index)
    : session.chunk_size;

  if (Number.isFinite(Number(declaredLength)) && Number(declaredLength) !== expected) {
    const err = new Error('That upload chunk was the wrong size. StudyCore will resend it.');
    err.statusCode = 400;
    err.userSafe = true;
    throw err;
  }

  const key = partKey(session.id, index);
  let written = 0;
  const meter = new PassThrough();
  meter.on('data', (chunk) => { written += chunk.length; });
  body.pipe(meter);

  await storage.putObject({ key, body: meter, contentType: 'application/octet-stream' });

  // A short write means the connection died mid-chunk. Delete the partial
  // object rather than recording it: a half-written chunk recorded as
  // complete would silently corrupt the assembled file.
  if (written !== expected) {
    await storage.deleteObject(key).catch(() => {});
    const err = new Error('That upload chunk was interrupted. StudyCore will resend it.');
    err.statusCode = 400;
    err.userSafe = true;
    throw err;
  }

  db.prepare(`
    INSERT INTO upload_session_parts (session_id, part_number, size, received_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id, part_number) DO UPDATE SET size = excluded.size, received_at = excluded.received_at
  `).run(session.id, index, written, nowIso());

  touchSession(session.id);
  return { partNumber: index, size: written };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function missingParts(session) {
  const have = new Set(receivedPartNumbers(session.id));
  const missing = [];
  for (let i = 0; i < session.total_chunks; i += 1) {
    if (!have.has(i)) missing.push(i);
  }
  return missing;
}

// Streams every chunk back out of storage, in order, as one continuous
// readable. Assembly therefore costs one chunk of memory, not one file.
function assembledStream(session) {
  const total = session.total_chunks;
  async function* generate() {
    for (let i = 0; i < total; i += 1) {
      const obj = await storage.getObject(partKey(session.id, i));
      const body = obj.body;
      if (body && typeof body[Symbol.asyncIterator] === 'function') {
        for await (const chunk of body) yield chunk;
      } else if (typeof Readable.fromWeb === 'function' && body && typeof body.getReader === 'function') {
        for await (const chunk of Readable.fromWeb(body)) yield chunk;
      } else if (body) {
        yield Buffer.from(await body.transformToByteArray());
      }
    }
  }
  return Readable.from(generate());
}

// Turn a fully-received session into a single stored object and return the
// descriptor the resource routes expect — deliberately the same shape Multer
// produced (`key`, `size`, `contentHash`, `bucket`, `originalname`,
// `mimetype`) so the upload routes treat a resumed upload and a classic
// multipart upload identically.
async function finalizeSession(session, { validateHead } = {}) {
  const missing = missingParts(session);
  if (missing.length) {
    const err = new Error('This upload is not finished yet. Some parts are still missing.');
    err.statusCode = 409;
    err.userSafe = true;
    err.missingParts = missing;
    throw err;
  }

  const ext = path.extname(session.file_name || '').toLowerCase();
  const key = `${uuidv4()}${ext}`;
  const hash = crypto.createHash('sha256');
  let size = 0;
  const head = Buffer.alloc(16);
  let headLen = 0;

  const source = assembledStream(session);
  const metered = new PassThrough();
  source.on('error', (err) => metered.destroy(err));
  source.on('data', (chunk) => {
    hash.update(chunk);
    size += chunk.length;
    if (headLen < 16) {
      const take = Math.min(16 - headLen, chunk.length);
      chunk.copy(head, headLen, 0, take);
      headLen += take;
    }
  });
  source.pipe(metered);

  await storage.putObject({ key, body: metered, contentType: session.mime_type });

  // Same magic-byte guarantee the multipart path enforces: the assembled
  // object must really be the type its extension claims, or it is deleted.
  if (typeof validateHead === 'function' && !validateHead(head.subarray(0, headLen), ext)) {
    await storage.deleteObject(key).catch(() => {});
    const err = new Error('The uploaded file does not match its file type. Please check the file and try again.');
    err.statusCode = 400;
    err.userSafe = true;
    throw err;
  }

  db.prepare(`
    UPDATE upload_sessions SET status = 'complete', storage_key = ?, updated_at = ? WHERE id = ?
  `).run(key, nowIso(), session.id);

  // The chunks have served their purpose; drop them so a finished upload
  // does not cost double storage.
  deleteChunks(session).catch(() => {});

  return {
    key,
    size,
    contentHash: hash.digest('hex'),
    bucket: storage.backendName(),
    originalname: session.file_name,
    mimetype: session.mime_type,
    resumable: true
  };
}

async function deleteChunks(session) {
  const parts = receivedPartNumbers(session.id);
  for (const part of parts) {
    await storage.deleteObject(partKey(session.id, part)).catch(() => {});
  }
  db.prepare('DELETE FROM upload_session_parts WHERE session_id = ?').run(session.id);
}

// Remove a session and everything it holds. Used for explicit cancellation,
// per-user pruning and expiry.
async function discardSession(sessionId) {
  const session = db.prepare('SELECT * FROM upload_sessions WHERE id = ?').get(String(sessionId));
  if (!session) return;
  await deleteChunks(session);
  if (session.storage_key && session.status !== 'claimed') {
    await storage.deleteObject(session.storage_key).catch(() => {});
  }
  db.prepare('DELETE FROM upload_sessions WHERE id = ?').run(session.id);
}

// A session whose assembled object has been attached to a real resource row
// must never have that object deleted by the sweeper.
function markClaimed(sessionId) {
  db.prepare(`
    UPDATE upload_sessions SET status = 'claimed', updated_at = ? WHERE id = ?
  `).run(nowIso(), String(sessionId));
}

function describe(session) {
  const parts = receivedParts(session.id);
  const received = parts.map((row) => row.part_number);
  const bytes = parts.reduce((sum, row) => sum + Number(row.size || 0), 0);
  return {
    id: session.id,
    fileName: session.file_name,
    fileSize: session.file_size,
    mimeType: session.mime_type,
    chunkSize: session.chunk_size,
    totalChunks: session.total_chunks,
    receivedParts: received,
    uploadedBytes: bytes,
    status: session.status,
    expiresAt: session.expires_at
  };
}

// ---------------------------------------------------------------------------
// Expiry sweeper
// ---------------------------------------------------------------------------
// Abandoned sessions (the uploader closed the tab and never came back) would
// otherwise keep their chunks in the bucket indefinitely. Swept hourly, and
// once shortly after boot so a restart also cleans up after a crash.
async function sweepExpiredSessions() {
  const expired = db.prepare(`
    SELECT id FROM upload_sessions WHERE expires_at <= ? AND status != 'claimed'
  `).all(nowIso());
  for (const row of expired) {
    await discardSession(row.id).catch(() => {});
  }
  return expired.length;
}

function startSweeper() {
  const timer = setInterval(() => { sweepExpiredSessions().catch(() => {}); }, 60 * 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();
  const initial = setTimeout(() => { sweepExpiredSessions().catch(() => {}); }, 30 * 1000);
  if (typeof initial.unref === 'function') initial.unref();
  return timer;
}

module.exports = {
  DEFAULT_CHUNK_SIZE,
  MIN_CHUNK_SIZE,
  MAX_CHUNK_SIZE,
  SESSION_TTL_MS,
  resolveChunkSize,
  createSession,
  getSession,
  isExpired,
  putPart,
  missingParts,
  finalizeSession,
  discardSession,
  markClaimed,
  describe,
  receivedPartNumbers,
  uploadedBytes,
  sweepExpiredSessions,
  startSweeper
};
