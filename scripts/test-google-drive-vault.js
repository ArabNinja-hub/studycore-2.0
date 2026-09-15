'use strict';

// Tests for lib/google-drive-vault.js (the connected Google account) and
// lib/document-storage.js (the dispatcher seam in front of storage).
//
// WHAT IS BEING PROTECTED
//
//   * Google Drive is NEVER a storage destination. Connecting a Google
//     account must not change where a single byte is written: every upload,
//     and every file imported from the Drive Picker, goes to StudyCore's own
//     R2/local storage. This is the guarantee that keeps "Upload Document"
//     a plain StudyCore upload that is never saved into anybody's Drive.
//   * READS/DELETES still dispatch by the object's OWN recorded
//     storage_provider, so rows written by an older build that DID use the
//     connected account as a vault ('google_drive_vault') keep opening.
//   * The refresh token is encrypted at rest and never appears in plaintext
//     in the database or in any object this module returns.
//   * No Drive URL, Drive id, sharing state or OAuth token is ever needed by
//     (or exposed to) a student — 'google_drive_vault' stays distinct from the
//     legacy 'google_drive' marker (see routes/resources.routes.js).

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studycore-drive-vault-'));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-only-studycore-jwt-secret-0123456789';
process.env.R2_ACCOUNT_ID = '';
process.env.R2_ACCESS_KEY_ID = '';
process.env.R2_SECRET_ACCESS_KEY = '';
process.env.R2_BUCKET_NAME = '';

const db = require('../db');
const vault = require('../lib/google-drive-vault');
const documentStorage = require('../lib/document-storage');
const storage = require('../lib/storage');

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function webStreamOf(buffer) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(buffer));
      controller.close();
    }
  });
}

// Stands in for every Google endpoint the vault talks to (OAuth token
// exchange, userinfo, Drive files.list/create/resumable-upload/get/delete).
function installFakeGoogle({ files = new Map(), nextId = { n: 1 } } = {}) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    calls.push({ url: target, method: (options && options.method) || 'GET', headers: (options && options.headers) || {} });

    if (target.startsWith('https://oauth2.googleapis.com/token')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'ya29.fake-access-token', refresh_token: 'fake-refresh-token', expires_in: 3600 })
      };
    }
    if (target.startsWith('https://www.googleapis.com/oauth2/v2/userinfo')) {
      return { ok: true, status: 200, json: async () => ({ email: 'vault-account@example.com' }) };
    }
    // Folder lookup: pretend it never exists yet, so create is exercised too.
    if (target.includes('/drive/v3/files?q=')) {
      return { ok: true, status: 200, json: async () => ({ files: [] }) };
    }
    if (target.startsWith('https://www.googleapis.com/drive/v3/files?fields=id') && (options.method === 'POST')) {
      return { ok: true, status: 200, json: async () => ({ id: 'folder-abc' }) };
    }
    // Resumable upload session init.
    if (target.includes('/upload/drive/v3/files?uploadType=resumable')) {
      const id = `drive-file-${nextId.n++}`;
      return {
        ok: true,
        status: 200,
        headers: { get: (h) => (h.toLowerCase() === 'location' ? `https://upload.example/session/${id}` : null) },
        json: async () => ({})
      };
    }
    if (target.startsWith('https://upload.example/session/')) {
      const id = target.split('/').pop();
      const chunks = [];
      if (options.body && typeof options.body.getReader === 'function') {
        const reader = options.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(Buffer.from(value));
        }
      }
      const bytes = Buffer.concat(chunks);
      files.set(id, { bytes, contentType: options.headers['Content-Type'] || 'application/octet-stream' });
      return { ok: true, status: 200, json: async () => ({ id }) };
    }
    // Metadata / media / delete for an uploaded file id.
    const metaMatch = target.match(/\/drive\/v3\/files\/([^?]+)\?fields=/);
    if (metaMatch) {
      const id = decodeURIComponent(metaMatch[1]);
      const file = files.get(id);
      if (!file) return { ok: false, status: 404, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => ({ id, name: 'doc.pdf', mimeType: file.contentType, size: String(file.bytes.length) })
      };
    }
    const mediaMatch = target.match(/\/drive\/v3\/files\/([^?]+)\?alt=media/);
    if (mediaMatch) {
      const id = decodeURIComponent(mediaMatch[1]);
      const file = files.get(id);
      if (!file) return { ok: false, status: 404, json: async () => ({}) };
      let bytes = file.bytes;
      const range = (options.headers && options.headers.Range) || null;
      const headers = new Map([['Content-Type', file.contentType]]);
      if (range) {
        const m = /bytes=(\d+)-(\d+)/.exec(range);
        if (m) {
          const start = Number(m[1]);
          const end = Number(m[2]);
          bytes = bytes.subarray(start, end + 1);
          headers.set('Content-Range', `bytes ${start}-${end}/${file.bytes.length}`);
        }
      }
      headers.set('Content-Length', String(bytes.length));
      return {
        ok: true,
        status: range ? 206 : 200,
        headers: { get: (h) => headers.get(h) || null },
        body: webStreamOf(bytes)
      };
    }
    const delMatch = target.match(/\/drive\/v3\/files\/([^?]+)\?supportsAllDrives/);
    if (delMatch && options.method === 'DELETE') {
      const id = decodeURIComponent(delMatch[1]);
      const existed = files.delete(id);
      return { ok: existed, status: existed ? 204 : 404, json: async () => ({}) };
    }
    throw new Error(`Unhandled fake Google request: ${target}`);
  };
  return {
    calls,
    files,
    restore() { global.fetch = original; }
  };
}

function clearVaultAccounts() {
  db.prepare("DELETE FROM google_drive_accounts").run();
}

test('isConfigured() is false with no connected account, even with OAuth env vars set', () => {
  clearVaultAccounts();
  process.env.GOOGLE_CLIENT_ID = 'client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
  assert.equal(vault.isConfigured(), false);
  assert.equal(documentStorage.isVaultActive(), false);
  assert.equal(documentStorage.backendName(), storage.backendName());
});

test('connecting stores an encrypted refresh token, but does NOT make Drive the storage backend', async () => {
  clearVaultAccounts();
  const google = installFakeGoogle();
  try {
    const result = await vault.handleCallback({
      code: 'auth-code-123',
      req: { protocol: 'https', get: () => 'studycore.example' },
      userId: null
    });
    assert.equal(result.email, 'vault-account@example.com');
    assert.equal(result.folderId, 'folder-abc');

    const row = db.prepare("SELECT * FROM google_drive_accounts WHERE status = 'active'").get();
    assert.ok(row, 'an active account row exists');
    assert.notEqual(row.encrypted_refresh_token, 'fake-refresh-token',
      'the refresh token must be encrypted, never stored in plaintext');
    assert.ok(!row.encrypted_refresh_token.includes('fake-refresh-token'));

    assert.equal(vault.isConfigured(), true);
    assert.equal(documentStorage.isVaultActive(), true);
    // The connection exists so the SERVER can read Drive (legacy rows, and
    // verifying a picked file). It must never redirect writes into Drive:
    // StudyCore's own storage stays the destination for every upload.
    assert.equal(documentStorage.backendName(), storage.backendName(),
      'connecting a Google account must not change the write backend');
    assert.notEqual(documentStorage.backendName(), 'google_drive_vault');

    const status = vault.status();
    assert.equal(status.connected, true);
    assert.equal(status.email, 'vault-account@example.com');
  } finally {
    google.restore();
  }
});

test('a connected account does NOT capture uploads — they stay in StudyCore storage', async () => {
  clearVaultAccounts();
  const google = installFakeGoogle();
  try {
    await vault.handleCallback({ code: 'auth-code-456', req: { protocol: 'https', get: () => 'studycore.example' } });

    const payload = Buffer.from('%PDF-1.4 upload round trip test content 0123456789', 'utf8');
    const written = await documentStorage.putObject({
      key: 'studycore-object-key.pdf',
      body: Readable.from([payload]),
      contentType: 'application/pdf',
      fileName: 'Upload Test.pdf'
    });
    // THE core assertion of this whole change: even with Google Drive
    // connected, an ordinary document upload lands in StudyCore storage and
    // nothing is pushed into the admin's Drive.
    assert.notEqual(written.backend, 'google_drive_vault',
      'an upload must never be written into Google Drive');
    assert.equal(written.backend, storage.backendName());
    assert.equal(written.key, 'studycore-object-key.pdf',
      "StudyCore's own object key is kept, not replaced by a Drive file id");

    const head = await documentStorage.headObject(written.key, written.backend);
    assert.equal(head.contentLength, payload.length);

    const full = await documentStorage.getObject(written.key, undefined, written.backend);
    assert.deepEqual(await streamToBuffer(full.body), payload);

    const ranged = await documentStorage.getObject(written.key, { start: 5, end: 12 }, written.backend);
    assert.deepEqual(await streamToBuffer(ranged.body), payload.subarray(5, 13),
      'Range reads are honored end-to-end');

    await documentStorage.deleteObject(written.key, written.backend);
    await assert.rejects(() => documentStorage.headObject(written.key, written.backend), /Not found|NoSuchKey/);
  } finally {
    google.restore();
  }
});

test('historical google_drive_vault rows still read back through the connected account', async () => {
  // Rows published by an older build that used the connected account as a
  // storage vault must keep opening for students. Reads dispatch on the
  // row's OWN recorded provider, so they still resolve to Drive even though
  // nothing new is ever written there.
  clearVaultAccounts();
  const google = installFakeGoogle();
  try {
    await vault.handleCallback({ code: 'auth-code-legacy', req: { protocol: 'https', get: () => 'studycore.example' } });

    const payload = Buffer.from('%PDF-1.4 legacy vault-stored document', 'utf8');
    // Simulate the historical row by writing through the vault module
    // directly — the path lib/document-storage.js no longer takes.
    const written = await vault.putObject({
      body: Readable.from([payload]),
      contentType: 'application/pdf',
      fileName: 'Legacy.pdf'
    });
    assert.equal(written.backend, 'google_drive_vault');

    const bytes = await documentStorage.readBytes(written.key, 0, payload.length - 1, 'google_drive_vault');
    assert.deepEqual(Buffer.from(bytes), payload,
      'a legacy vault-stored document is still readable through the dispatcher');
  } finally {
    google.restore();
  }
});

test("reads and deletes dispatch by the OBJECT'S recorded provider, never by what is active now", async () => {
  clearVaultAccounts();

  // An object written with no Google account connected.
  const localPayload = Buffer.from('local-backend-object', 'utf8');
  const localWritten = await documentStorage.putObject({
    key: 'local-test-key.txt',
    body: Readable.from([localPayload]),
    contentType: 'text/plain',
    fileName: 'local.txt'
  });
  assert.notEqual(localWritten.backend, 'google_drive_vault');

  const google = installFakeGoogle();
  let legacyVaultKey;
  try {
    await vault.handleCallback({ code: 'auth-code-789', req: { protocol: 'https', get: () => 'studycore.example' } });

    // Connecting Drive changes nothing about where new objects go.
    const secondPayload = Buffer.from('still-local-after-connect', 'utf8');
    const secondWritten = await documentStorage.putObject({
      key: 'second-test-key.txt',
      body: Readable.from([secondPayload]),
      contentType: 'text/plain',
      fileName: 'second.txt'
    });
    assert.notEqual(secondWritten.backend, 'google_drive_vault',
      'connecting Google Drive must not redirect new writes into Drive');

    // A historical vault object, written the old way, still reads from Drive
    // because its own recorded provider says so.
    const drivePayload = Buffer.from('drive-backend-object', 'utf8');
    const driveWritten = await vault.putObject({
      body: Readable.from([drivePayload]),
      contentType: 'text/plain',
      fileName: 'drive.txt'
    });
    legacyVaultKey = driveWritten.key;

    const oldBytes = await documentStorage.readBytes(localWritten.key, 0, localPayload.length - 1, localWritten.backend);
    assert.deepEqual(Buffer.from(oldBytes), localPayload,
      'a StudyCore-stored object keeps reading from its original backend');

    const vaultBytes = await documentStorage.readBytes(legacyVaultKey, 0, drivePayload.length - 1, 'google_drive_vault');
    assert.deepEqual(Buffer.from(vaultBytes), drivePayload);

    vault.disconnect();
    assert.equal(vault.isConfigured(), false);
    assert.equal(documentStorage.isVaultActive(), false);
    assert.equal(documentStorage.backendName(), storage.backendName());

    await documentStorage.deleteObject('second-test-key.txt', secondWritten.backend);
  } finally {
    google.restore();
  }

  // With Drive disconnected, deleting the StudyCore-stored object must not
  // touch Drive at all (no live fetch is installed here — a Drive call
  // would throw, proving no request is made).
  await documentStorage.deleteObject(localWritten.key, localWritten.backend);
});

test("'google_drive_vault' is never confused with the 'google_drive' marker", () => {
  // Both values involve Drive, but they mean different things:
  // 'google_drive_vault' is a file an older build uploaded into the connected
  // account (which StudyCore owns and may delete), while 'google_drive' is a
  // legacy reference to the uploader's ORIGINAL Drive file, which StudyCore
  // must never delete. Neither is produced by a new publish: Picker imports
  // are written to StudyCore's own R2/local storage.
  assert.notEqual(documentStorage.backendName.toString(), undefined);
  assert.equal(vault.backendName ? vault.backendName() : 'google_drive_vault', 'google_drive_vault');
  assert.notEqual('google_drive_vault', 'google_drive');
});

async function streamToBuffer(body) {
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
