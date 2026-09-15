'use strict';

// Regression tests for the VIEWER-side Google Drive retrieval path.
//
// THE BUG CLASS THIS PINS
//
// The admin can select a file and publish it — the resource row is correctly
// registered as a Google Drive reference — but the backend then fails to read
// that same file when a STUDENT opens it, so the viewer shows "Document
// unavailable" for a document that is perfectly fine in Drive.
//
// Publish-time verification and the student read use the SAME credential and
// the SAME calls, so anything that can change between the two is exactly where
// this failure lives:
//
//   1. THE ACCESS TOKEN. The vault caches a minted token in-process for ~55
//      minutes. Google can revoke it long before that (admin password change,
//      "sign out of all devices", re-consent, token-lifetime skew). Drive then
//      answers 401 Invalid Credentials to a token the process still believes
//      is fresh. The REFRESH token is untouched, so re-minting recovers
//      immediately — but the old code treated the 401 as "this connection can
//      no longer read this document" and every student read failed until the
//      process restarted.
//
//   2. THE DOWNLOAD REQUEST. files.get?alt=media is refused with 403
//      cannotDownloadAbusiveFile for any file Google's scanner has flagged —
//      routine for scanned past papers and large shared PDFs. Metadata
//      (files.get) is NOT refused, so publish-time verification passes and
//      only the student's byte read fails. Drive serves the file once the
//      caller sets acknowledgeAbuse=true.
//
// Both faults are invisible to the admin and only ever surface in the viewer,
// which is precisely the reported symptom.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studycore-drive-viewer-'));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-only-studycore-jwt-secret-0123456789';
process.env.R2_ACCOUNT_ID = '';
process.env.R2_ACCESS_KEY_ID = '';
process.env.R2_SECRET_ACCESS_KEY = '';
process.env.R2_BUCKET_NAME = '';
process.env.GOOGLE_CLIENT_ID = '1076280995038-testclient.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
// No browser API key: these tests must prove the OAuth connection itself
// works, with no link-share fallback quietly rescuing a broken token path.
delete process.env.GOOGLE_API_KEY;

const vault = require('../lib/google-drive-vault');
const driveDocuments = require('../lib/drive-documents');
const db = require('../db');

const FILE_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
const FLAGGED_ID = '1FlaggedByGoogleScanner0000000000';
const DOC_ID = '1GoogleDocFileId00000000000000000';

const PDF_BYTES = Buffer.concat([
  Buffer.from('%PDF-1.4\n', 'latin1'),
  Buffer.from('1 0 obj<</Type/Catalog>>endobj\n', 'latin1'),
  Buffer.from('0123456789'.repeat(64), 'latin1'),
  Buffer.from('trailer<</Root 1 0 R>>\n%%EOF', 'latin1')
]);

function webStreamOf(buffer) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(buffer));
      controller.close();
    }
  });
}

// A JSON error shaped exactly like Drive's, including .clone() — the reader
// inspects the error body to learn WHY a download was refused.
function driveErrorResponse(status, reason, message) {
  const payload = { error: { code: status, message, errors: [{ reason, message }] } };
  const make = () => ({
    ok: false,
    status,
    json: async () => payload,
    clone: make,
    headers: { get: () => null }
  });
  return make();
}

/**
 * Google, modelled around the two things that differ between the admin's
 * publish and the student's read.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.flagged]      the file is flagged as abusive, so
 *                                      alt=media requires acknowledgeAbuse
 * @param {boolean} [opts.workspace]    serve a native Google Doc instead
 */
function installFakeGoogle({ flagged = false, workspace = false } = {}) {
  const original = global.fetch;
  const calls = [];
  // Every token Google currently considers valid. Clearing this models a
  // revocation: the minted access token dies, the refresh token survives.
  const liveTokens = new Set();
  let minted = 0;

  function mint() {
    minted += 1;
    const token = `ya29.access-token-${minted}`;
    liveTokens.add(token);
    return token;
  }

  const fileId = workspace ? DOC_ID : (flagged ? FLAGGED_ID : FILE_ID);

  global.fetch = async (url, options = {}) => {
    const target = String(url);
    const method = (options && options.method) || 'GET';

    if (target === 'https://oauth2.googleapis.com/token') {
      const body = String((options && options.body) || '');
      const grant = body.includes('grant_type=authorization_code') ? 'exchange' : 'refresh';
      calls.push({ kind: 'token', grant });
      const token = mint();
      return {
        ok: true,
        status: 200,
        json: async () => (grant === 'exchange'
          ? {
            access_token: token,
            refresh_token: 'persisted-refresh-token',
            expires_in: 3600,
            scope: 'https://www.googleapis.com/auth/drive.file'
          }
          : { access_token: token, expires_in: 3600, scope: 'https://www.googleapis.com/auth/drive.file' })
      };
    }

    if (target.startsWith('https://www.googleapis.com/oauth2/v2/userinfo')) {
      return { ok: true, status: 200, json: async () => ({ email: 'library-owner@example.com' }) };
    }
    if (target.includes('/files?q=')) {
      return { ok: true, status: 200, json: async () => ({ files: [{ id: 'folder-abc' }] }) };
    }

    const auth = (options.headers && options.headers.Authorization) || '';
    const token = auth.replace('Bearer ', '');
    const tokenValid = liveTokens.has(token);

    const kind = target.includes('/export')
      ? 'export'
      : (target.includes('alt=media') ? 'download' : 'metadata');
    calls.push({
      kind,
      method,
      token,
      tokenValid,
      acknowledgeAbuse: target.includes('acknowledgeAbuse=true')
    });

    // A revoked/expired access token. Drive cannot tell us anything about the
    // file until we present a live credential.
    if (!tokenValid) {
      return driveErrorResponse(401, 'authError', 'Invalid Credentials');
    }

    if (kind === 'metadata') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: fileId,
          name: workspace ? 'Lecture Notes' : 'Contract Law Notes.pdf',
          mimeType: workspace ? 'application/vnd.google-apps.document' : 'application/pdf',
          size: workspace ? undefined : String(PDF_BYTES.length),
          modifiedTime: '2025-01-01T00:00:00.000Z',
          trashed: false
        })
      };
    }

    if (kind === 'export') {
      const headers = new Map([['Content-Type', 'application/pdf'], ['Content-Length', String(PDF_BYTES.length)]]);
      return {
        ok: true,
        status: 200,
        headers: { get: (h) => headers.get(h) || null },
        arrayBuffer: async () => PDF_BYTES.buffer.slice(PDF_BYTES.byteOffset, PDF_BYTES.byteOffset + PDF_BYTES.byteLength),
        body: webStreamOf(PDF_BYTES)
      };
    }

    // alt=media
    if (workspace) {
      return driveErrorResponse(403, 'fileNotDownloadable', 'Only files with binary content can be downloaded.');
    }
    if (flagged && !target.includes('acknowledgeAbuse=true')) {
      return driveErrorResponse(
        403,
        'cannotDownloadAbusiveFile',
        'This file has been identified as malware or spam and cannot be downloaded.'
      );
    }

    let bytes = PDF_BYTES;
    let status = 200;
    const headers = new Map([['Content-Type', 'application/pdf']]);
    const range = (options.headers && options.headers.Range) || null;
    if (range) {
      const m = /bytes=(\d+)-(\d+)/.exec(range);
      if (m) {
        const start = Number(m[1]);
        const end = Math.min(Number(m[2]), PDF_BYTES.length - 1);
        bytes = PDF_BYTES.subarray(start, end + 1);
        status = 206;
        headers.set('Content-Range', `bytes ${start}-${end}/${PDF_BYTES.length}`);
      }
    }
    headers.set('Content-Length', String(bytes.length));
    return {
      ok: status === 200,
      status,
      headers: { get: (h) => headers.get(h) || null },
      body: webStreamOf(bytes)
    };
  };

  return {
    calls,
    fileId,
    /** Google revokes every currently-minted access token. */
    revokeAccessTokens() { liveTokens.clear(); },
    countOf(kind) { return calls.filter((c) => c.kind === kind).length; },
    restore() { global.fetch = original; }
  };
}

async function connect() {
  db.prepare('DELETE FROM google_drive_accounts').run();
  await vault.handleCallback({
    code: 'auth-code-1',
    req: { protocol: 'https', get: () => 'studycore.example' },
    userId: null
  });
  driveDocuments.forgetCaches();
}

async function drain(body) {
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// 1. A revoked access token must not break the viewer
// ---------------------------------------------------------------------------

test('the viewer re-mints a revoked access token instead of reporting the file unreadable', async () => {
  const google = installFakeGoogle();
  try {
    await connect();

    // The admin selects the file: publish-time verification reads metadata
    // with the server's own credential and succeeds.
    const published = await driveDocuments.getMetadata(FILE_ID, { fresh: true });
    assert.equal(published.name, 'Contract Law Notes.pdf');

    // Google now revokes the access token StudyCore holds. The refresh token
    // is still perfectly valid — only the short-lived token is dead.
    google.revokeAccessTokens();
    driveDocuments.forgetCaches();

    // A student opens the document. This must transparently recover.
    const head = await driveDocuments.headObject(FILE_ID);
    assert.equal(head.contentLength, PDF_BYTES.length,
      'the viewer still gets the real size');
    assert.equal(head.contentType, 'application/pdf');

    const object = await driveDocuments.getObject(FILE_ID);
    const bytes = await drain(object.body);
    assert.ok(bytes.equals(PDF_BYTES),
      'the student receives the original Drive bytes, unchanged');

    // It recovered by refreshing the token, not by giving up.
    assert.ok(google.countOf('token') >= 2,
      'a fresh access token was minted from the refresh token');
    const refused = google.calls.filter((c) => c.tokenValid === false);
    assert.ok(refused.length >= 1, 'the dead token was genuinely refused first');
  } finally {
    google.restore();
  }
});

test('a re-minted token is reused, so one revocation does not refresh on every chunk', async () => {
  const google = installFakeGoogle();
  try {
    await connect();
    await driveDocuments.getMetadata(FILE_ID, { fresh: true });

    google.revokeAccessTokens();
    driveDocuments.forgetCaches();

    // First read recovers (and caches the new token).
    await driveDocuments.readBytes(FILE_ID, 0, 63);
    const afterRecovery = google.countOf('token');

    // pdf.js pages the document in further range requests; these must ride on
    // the recovered token rather than minting a new one each time.
    await driveDocuments.readBytes(FILE_ID, 64, 127);
    await driveDocuments.readBytes(FILE_ID, 128, 191);

    assert.equal(google.countOf('token'), afterRecovery,
      'subsequent reads reuse the recovered access token');
  } finally {
    google.restore();
  }
});

test('range requests still return the exact slice after a token recovery', async () => {
  const google = installFakeGoogle();
  try {
    await connect();
    google.revokeAccessTokens();
    driveDocuments.forgetCaches();

    const slice = await driveDocuments.readBytes(FILE_ID, 10, 41);
    assert.equal(slice.length, 32);
    assert.ok(slice.equals(PDF_BYTES.subarray(10, 42)),
      'the recovered read returns the requested byte range, not the whole file');
  } finally {
    google.restore();
  }
});

// ---------------------------------------------------------------------------
// 2. Google's abuse flag must not make a published document unopenable
// ---------------------------------------------------------------------------

test('a Drive file flagged by Google still downloads for the viewer', async () => {
  const google = installFakeGoogle({ flagged: true });
  try {
    await connect();

    // Publish-time verification only reads METADATA, which Drive never
    // refuses for a flagged file — this is why the admin sees no problem.
    const meta = await driveDocuments.getMetadata(FLAGGED_ID, { fresh: true });
    assert.equal(meta.contentType, 'application/pdf');

    // The student's byte read is the one Drive refuses until acknowledged.
    const object = await driveDocuments.getObject(FLAGGED_ID);
    const bytes = await drain(object.body);
    assert.ok(bytes.equals(PDF_BYTES),
      'the flagged-but-legitimate document is served to the student');

    const downloads = google.calls.filter((c) => c.kind === 'download');
    assert.equal(downloads.length, 2, 'refused once, then retried');
    assert.equal(downloads[0].acknowledgeAbuse, false);
    assert.equal(downloads[1].acknowledgeAbuse, true,
      'the retry acknowledges the abuse flag the admin already vouched for');
  } finally {
    google.restore();
  }
});

// ---------------------------------------------------------------------------
// 3. Real failures must still be reported honestly
// ---------------------------------------------------------------------------

test('a genuinely inaccessible file is still reported as an access failure, not silently retried forever', async () => {
  const original = global.fetch;
  let tokenMints = 0;
  let metadataCalls = 0;
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target === 'https://oauth2.googleapis.com/token') {
      tokenMints += 1;
      const body = String((options && options.body) || '');
      return {
        ok: true,
        status: 200,
        json: async () => (body.includes('authorization_code')
          ? { access_token: 'ya29.tok', refresh_token: 'r', expires_in: 3600 }
          : { access_token: `ya29.tok-${tokenMints}`, expires_in: 3600 })
      };
    }
    if (target.startsWith('https://www.googleapis.com/oauth2/v2/userinfo')) {
      return { ok: true, status: 200, json: async () => ({ email: 'e@example.com' }) };
    }
    if (target.includes('/files?q=')) {
      return { ok: true, status: 200, json: async () => ({ files: [{ id: 'folder' }] }) };
    }
    metadataCalls += 1;
    // A live token that is simply not permitted to read this file.
    return driveErrorResponse(403, 'insufficientFilePermissions', 'The user does not have sufficient permissions for this file.');
  };

  try {
    await connect();
    const before = metadataCalls;
    await assert.rejects(
      () => driveDocuments.getMetadata(FILE_ID, { fresh: true }),
      (err) => {
        assert.equal(err.statusCode, 403);
        assert.equal(err.code, 'DriveAccessDenied');
        assert.equal(err.googleDriveError.httpStatus, 403);
        assert.equal(err.googleDriveError.errorCode, 403);
        assert.equal(err.googleDriveError.errorReason, 'insufficientFilePermissions');
        assert.equal(err.googleDriveError.errorMessage, 'The user does not have sufficient permissions for this file.');
        assert.equal(err.googleDriveError.fileId, FILE_ID);
        assert.equal(err.googleDriveError.authMethod, 'server_oauth');
        assert.equal(err.googleDriveError.authAccount, 'e@example.com');
        return true;
      },
      'a real permission problem is reported as an access failure'
    );
    assert.equal(metadataCalls - before, 1,
      'a 403 permission failure is not retried with a new token — the token was never the problem');
  } finally {
    global.fetch = original;
  }
});

test('a deleted Drive file is still reported as missing', async () => {
  const original = global.fetch;
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target === 'https://oauth2.googleapis.com/token') {
      const body = String((options && options.body) || '');
      return {
        ok: true,
        status: 200,
        json: async () => (body.includes('authorization_code')
          ? { access_token: 'ya29.tok', refresh_token: 'r', expires_in: 3600 }
          : { access_token: 'ya29.tok', expires_in: 3600 })
      };
    }
    if (target.startsWith('https://www.googleapis.com/oauth2/v2/userinfo')) {
      return { ok: true, status: 200, json: async () => ({ email: 'e@example.com' }) };
    }
    if (target.includes('/files?q=')) {
      return { ok: true, status: 200, json: async () => ({ files: [{ id: 'folder' }] }) };
    }
    return driveErrorResponse(404, 'notFound', 'File not found');
  };

  try {
    await connect();
    await assert.rejects(
      () => driveDocuments.getMetadata(FILE_ID, { fresh: true }),
      (err) => {
        assert.equal(err.code, 'NoSuchKey');
        return true;
      }
    );
  } finally {
    global.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// 4. Workspace exports share the same recovery
// ---------------------------------------------------------------------------

test('a native Google Doc exports to PDF even when the cached token was revoked', async () => {
  const google = installFakeGoogle({ workspace: true });
  try {
    await connect();
    await driveDocuments.getMetadata(DOC_ID, { fresh: true });

    google.revokeAccessTokens();
    driveDocuments.forgetCaches();

    const head = await driveDocuments.headObject(DOC_ID);
    assert.equal(head.contentType, 'application/pdf',
      'the Google Doc is served as its PDF export');
    assert.equal(head.contentLength, PDF_BYTES.length);
  } finally {
    google.restore();
  }
});

// ---------------------------------------------------------------------------
// 5. The connection itself
// ---------------------------------------------------------------------------

test('connecting an account that did not grant drive.file is refused at connect time', async () => {
  const original = global.fetch;
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target === 'https://oauth2.googleapis.com/token') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'ya29.tok',
          refresh_token: 'r',
          expires_in: 3600,
          // The admin unticked the Drive permission on the consent screen.
          scope: 'https://www.googleapis.com/auth/userinfo.email'
        })
      };
    }
    return { ok: true, status: 200, json: async () => ({ email: 'e@example.com' }) };
  };
  try {
    db.prepare('DELETE FROM google_drive_accounts').run();
    await assert.rejects(
      () => vault.handleCallback({
        code: 'code',
        req: { protocol: 'https', get: () => 'studycore.example' },
        userId: null
      }),
      (err) => {
        assert.equal(err.userSafe, true);
        assert.match(err.message, /permission to read Drive files/i);
        return true;
      },
      'a connection that cannot read Drive must never be stored as usable'
    );
    assert.equal(vault.isConfigured(), false,
      'no half-working connection is persisted');
  } finally {
    global.fetch = original;
  }
});

test('the refresh token is decrypted per read and a rotated JWT_SECRET asks for a reconnect', async () => {
  const google = installFakeGoogle();
  try {
    await connect();
    const token = await vault.getAccessToken();
    assert.match(token, /^ya29\./);

    // Rotating the server secret makes the stored ciphertext unreadable. That
    // is a reconnect, not a Drive permission problem, and must say so.
    const previous = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'a-completely-different-secret-0123456789';
    try {
      await assert.rejects(
        () => vault.getAccessToken({ forceRefresh: true }),
        (err) => {
          assert.equal(err.userSafe, true);
          assert.equal(err.statusCode, 503);
          assert.match(err.message, /reconnect/i);
          return true;
        }
      );
    } finally {
      process.env.JWT_SECRET = previous;
    }
  } finally {
    google.restore();
  }
});
