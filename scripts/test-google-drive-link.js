'use strict';

// Regression tests for the Google Drive Picker REGISTRATION path and the
// server-side Drive reference reader.
//
// THE MODEL THIS PINS
//
// Google Drive is the admin's document SOURCE LIBRARY. A file picked with
// "Select from Google Drive" is REGISTERED as a Google Drive-backed resource:
// the row stores the Drive file id plus Drive's metadata, no bytes are copied
// anywhere, and students are served by the BACKEND, which reads the original
// file with its own connected Google credentials and streams it through the
// session/program/subscription-gated /api/resources/:id/stream endpoint.
//
// The old copy-at-publish behaviour ("your document is being moved into
// StudyCore") is deliberately gone: it either depended on the browser's
// short-lived Picker token, or — for reference rows — published files the
// server had never proven it could read, which surfaced to students as
// "Document unavailable: this document may have been moved, renamed or
// deleted" for files that were perfectly fine in Drive.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studycore-drive-'));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-only-studycore-jwt-secret-0123456789';
// Keep R2 unconfigured so any accidental write would land in the local object
// store, where these tests would see it.
process.env.R2_ACCOUNT_ID = '';
process.env.R2_ACCESS_KEY_ID = '';
process.env.R2_SECRET_ACCESS_KEY = '';
process.env.R2_BUCKET_NAME = '';
// The same OAuth client the Picker uses — the server-side connection shares
// it (there is no second Google integration).
process.env.GOOGLE_CLIENT_ID = '1076280995038-testclient.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
// Browser API key: only able to read files their owner link-shared.
process.env.GOOGLE_API_KEY = 'AIzaTestServerSideKey0000000000000000000';

const storage = require('../lib/storage');
const googleDrive = require('../lib/google-drive');
const driveDocuments = require('../lib/drive-documents');
const documentStorage = require('../lib/document-storage');
const vault = require('../lib/google-drive-vault');
const db = require('../db');

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

// Google Drive file ids are long URL-safe tokens; short placeholders are
// rejected by the id validator, so the fixtures use realistic ones.
const DRIVE_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
const DOC_ID = '1ZyXwVuTsRqPoNmLkJiHgFeDcBa987654';
const LINKED_ID = '1LinkSharedFileIdLinkSharedFileId00';
const BAD_ID = '1BadFileIdBadFileIdBadFileId00000';
const EXE_ID = '1ExeFileIdExeFileIdExeFileId00000';
const VID_ID = '1VidFileIdVidFileIdVidFileId00000';

const VAULT_TOKEN = 'ya29.server-vault-access-token';

const PDF_BYTES = Buffer.concat([
  Buffer.from('%PDF-1.4\n', 'latin1'),
  Buffer.from('1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF', 'latin1')
]);

function webStreamOf(buffer) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(buffer));
      controller.close();
    }
  });
}

// Stands in for Google. Records every request so the tests can assert which
// endpoint was called and with which credential. `grants` models Drive's
// permission rules per file:
//   vault — the connected account (StudyCore's own server credential)
//   key   — the browser API key (link-shared files only)
async function connectVault(google) {
  await vault.handleCallback({
    code: 'auth-code-1',
    req: { protocol: 'https', get: () => 'studycore.example' },
    userId: null
  });
  return google;
}

function installFakeGoogle({ files = null } = {}) {
  const calls = [];
  const original = global.fetch;
  const defaultFiles = {
    [DRIVE_ID]: { name: 'Contract Law Notes.pdf', mime: 'application/pdf', bytes: PDF_BYTES, grants: ['vault'] },
    [DOC_ID]: { name: 'Lecture 3', mime: 'application/vnd.google-apps.document', bytes: null, grants: ['vault'] },
    [LINKED_ID]: { name: 'Link Shared Notes.pdf', mime: 'application/pdf', bytes: PDF_BYTES, grants: ['key'] }
  };
  // `files` REPLACES the catalog when given (so a test can model an empty or
  // hostile Drive — even `{}`); omit it for the standard library above.
  const catalog = new Map(Object.entries(files === null || files === undefined ? defaultFiles : files));


  global.fetch = async (url, options = {}) => {
    const target = String(url);
    const method = (options && options.method) || 'GET';
    calls.push({ url: target, method, headers: (options && options.headers) || {} });

    if (target === 'https://oauth2.googleapis.com/token') {
      const body = String((options && options.body) || '');
      if (body.includes('grant_type=authorization_code')) {
        return {
          ok: true, status: 200,
          json: async () => ({ access_token: VAULT_TOKEN, refresh_token: 'fake-refresh-token', expires_in: 3600 })
        };
      }
      return { ok: true, status: 200, json: async () => ({ access_token: VAULT_TOKEN, expires_in: 3600 }) };
    }
    if (target.startsWith('https://www.googleapis.com/oauth2/v2/userinfo')) {
      return { ok: true, status: 200, json: async () => ({ email: 'library@example.com' }) };
    }
    if (target.includes('/files?q=')) {
      return { ok: true, status: 200, json: async () => ({ files: [{ id: 'folder-abc' }] }) };
    }
    if (target.includes('/permissions')) {
      return { ok: true, status: 200, json: async () => ({ id: 'perm-1' }) };
    }

    const auth = (options.headers && options.headers.Authorization) || '';
    const credential = auth === `Bearer ${VAULT_TOKEN}`
      ? 'vault'
      : (target.includes(`key=${process.env.GOOGLE_API_KEY}`) ? 'key' : null);

    const idMatch = target.match(/\/drive\/v3\/files\/([^?/]+)/);
    const fileId = idMatch ? decodeURIComponent(idMatch[1]) : null;
    const file = catalog.get(fileId);

    if (target.includes('/export')) {
      if (!file || !file.grants.includes(credential)) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      return {
        ok: true, status: 200,
        headers: { get: () => 'application/pdf' },
        arrayBuffer: async () => PDF_BYTES.buffer.slice(PDF_BYTES.byteOffset, PDF_BYTES.byteOffset + PDF_BYTES.byteLength),
        body: webStreamOf(PDF_BYTES)
      };
    }

    if (target.includes('fields=')) {
      if (!file || !file.grants.includes(credential)) {
        // Drive hides ungranted files behind 404; an explicit revocation
        // answers 403 instead.
        const status = credential === 'vault' && file && file.refuseVaultWith ? file.refuseVaultWith : 404;
        return { ok: false, status, json: async () => ({}) };
      }
      const meta = file.meta || { id: fileId, name: file.name, mimeType: file.mime, size: file.bytes ? String(file.bytes.length) : undefined };
      return { ok: true, status: 200, json: async () => meta };
    }

    // alt=media.
    if (!file || !file.grants.includes(credential)) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    const requested = (options.headers && options.headers.Range) || null;
    let bytes = file.bytes || PDF_BYTES;
    const headers = new Map([['Content-Type', file.mime]]);
    if (requested) {
      const m = /bytes=(\d+)-(\d+)/.exec(requested);
      if (m) {
        bytes = bytes.subarray(Number(m[1]), Number(m[2]) + 1);
        headers.set('Content-Range', `bytes ${m[1]}-${m[2]}/${(file.bytes || PDF_BYTES).length}`);
      }
    }
    headers.set('Content-Length', String(bytes.length));
    return {
      ok: true, status: requested ? 206 : 200,
      headers: { get: (h) => headers.get(h) || null },
      body: webStreamOf(bytes)
    };
  };
  return { calls, restore() { global.fetch = original; } };
}

test.beforeEach(() => driveDocuments.forgetCaches());

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('a picked Drive PDF is REGISTERED as a reference — nothing is copied out of Drive', async () => {
  const google = installFakeGoogle();
  try {
    await connectVault(google);
    const file = await googleDrive.registerFile({
      fileId: DRIVE_ID,
      accessToken: 'ya29.picker-token',
      fileName: 'Contract Law Notes.pdf',
      mimeType: 'application/pdf'
    });

    // The returned shape mirrors a multer upload, but a reference stores no
    // object: no key, no hash, and the Drive provider marker as bucket.
    assert.equal(file.key, null, 'no StudyCore storage key is produced');
    assert.equal(file.bucket, 'google_drive', 'the provider marker is google_drive');
    assert.equal(file.driveFileId, DRIVE_ID, 'the Drive file id is carried on the row');
    assert.equal(file.originalname, 'Contract Law Notes.pdf', 'Drive\'s own name wins');
    assert.equal(file.mimetype, 'application/pdf');
    assert.equal(file.size, PDF_BYTES.length, 'Drive\'s own size wins');
    assert.equal(file.contentHash, null, 'no hash — the bytes were never copied');

    // Registration uses the SERVER credential for both metadata and a
    // one-byte media probe. The probe is deliberate: Drive can allow metadata
    // access while refusing the later alt=media request, which used to let a
    // broken resource publish and fail only when a student opened it.
    const metaCall = google.calls.find((c) => c.url.includes(`files/${DRIVE_ID}`) && c.url.includes('fields='));
    assert.ok(metaCall, 'the server verified the file with Drive metadata');
    assert.equal(metaCall.headers.Authorization, `Bearer ${VAULT_TOKEN}`,
      'verification uses the connected account, not the Picker token');
    const mediaCalls = google.calls.filter((c) => c.url.includes(`files/${DRIVE_ID}`) && c.url.includes('alt=media'));
    assert.equal(mediaCalls.length, 1, 'publishing performs one media-readability probe');
    assert.match(mediaCalls[0].headers.Range || '', /^bytes=0-0$/,
      'the publish probe reads only one byte');
    assert.equal(mediaCalls[0].headers.Authorization, `Bearer ${VAULT_TOKEN}`,
      'the media probe uses the connected account, not the Picker token');
    assert.equal(google.calls.filter((c) => c.url.includes('/export')).length, 0,
      'binary files are not exported at publish time');
  } finally {
    google.restore();
  }
});

test('a link-shared file can still be registered through the API key', async () => {
  const google = installFakeGoogle();
  try {
    // No connected account (fresh db): only the browser API key exists, and
    // this file's owner link-shared it, so the server can genuinely read it.
    db.prepare('DELETE FROM google_drive_accounts').run();
    const file = await googleDrive.registerFile({
      fileId: LINKED_ID,
      fileName: 'Link Shared Notes.pdf',
      mimeType: 'application/pdf'
    });
    assert.equal(file.driveFileId, LINKED_ID);
    assert.equal(file.mimetype, 'application/pdf');
    assert.ok(google.calls.some((c) => c.url.includes(`key=${process.env.GOOGLE_API_KEY}`)),
      'the API-key fallback read the link-shared file');
  } finally {
    // Reconnect while the scripted Google is still in place.
    await connectVault(google);
    google.restore();
  }
});

test('a Drive reference is read server-side with Range support when a student opens it', async () => {
  const google = installFakeGoogle();
  try {
    await connectVault(google);
    // Exactly how the stream route resolves a Drive-backed row: provider
    // 'google_drive', key = the Drive file id.
    const head = await documentStorage.headObject(DRIVE_ID, 'google_drive');
    assert.equal(head.contentLength, PDF_BYTES.length);
    assert.equal(head.contentType, 'application/pdf');

    const full = await documentStorage.readBytes(DRIVE_ID, 0, PDF_BYTES.length - 1, 'google_drive');
    assert.deepEqual(full, PDF_BYTES, 'the server-side proxy receives the exact Drive bytes');

    // pdf.js pages a PDF in 128KB ranges — those must reach Drive as ranges.
    const ranged = await documentStorage.readBytes(DRIVE_ID, 4, 8, 'google_drive');
    assert.deepEqual(ranged, PDF_BYTES.subarray(4, 9), 'Range reads are honored end-to-end');
    const rangedCall = google.calls.find((c) => c.headers && c.headers.Range === 'bytes=4-8');
    assert.ok(rangedCall, 'the Range header is forwarded to Google Drive');
    assert.ok(rangedCall.url.includes('alt=media'), 'student bytes come from the Drive media endpoint');
    assert.equal(rangedCall.headers.Authorization, `Bearer ${VAULT_TOKEN}`,
      'student reads authenticate as the connected account');
  } finally {
    google.restore();
  }
});

test('deleting a Drive reference never deletes the original Drive file', async () => {
  const google = installFakeGoogle();
  try {
    await connectVault(google);
    await documentStorage.deleteObject(DRIVE_ID, 'google_drive');
    const deletes = google.calls.filter((c) => c.method === 'DELETE');
    assert.equal(deletes.length, 0,
      'a source document belongs to its owner in Google Drive');
  } finally {
    google.restore();
  }
});

test('a native Google Doc is verified through its PDF export and cached for the first read', async () => {
  const google = installFakeGoogle();
  try {
    await connectVault(google);
    const file = await googleDrive.registerFile({ fileId: DOC_ID, accessToken: 'ya29.picker-token' });
    assert.equal(file.mimetype, 'application/pdf', 'a Google Doc is served as its PDF export');
    assert.equal(file.originalname, 'Lecture 3', 'the Drive name is kept');
    assert.equal(file.size, null, 'an export has no size until it is produced');
    // Workspace files have no alt=media endpoint, so publish verification
    // must exercise the PDF export path. The result is cached and reused by
    // the first student HEAD/read; no second export should be needed.
    assert.equal(google.calls.filter((c) => c.url.includes('/export')).length, 1,
      'the PDF export is verified once at publish time');
    const head = await documentStorage.headObject(DOC_ID, 'google_drive');
    assert.equal(head.contentType, 'application/pdf');
    assert.equal(head.contentLength, PDF_BYTES.length, 'the export is measured once and cached');
    const exportCalls = google.calls.filter((c) => c.url.includes('/export'));
    assert.equal(exportCalls.length, 1, 'the Workspace export is reused on read');
    assert.match(exportCalls[0].url, /mimeType=application%2Fpdf/);
  } finally {
    google.restore();
  }
});

test('Drive picks are validated exactly like an ordinary upload', async () => {
  const google = installFakeGoogle({
    files: {
      // Claims an allowlisted type but is not: a Drive file whose type is
      // genuinely outside the document allowlist.
      [EXE_ID]: { name: 'malware.exe', mime: 'application/x-msdownload', bytes: Buffer.from('MZ executable'), grants: ['vault'] },
      [VID_ID]: { name: 'lecture.mp4', mime: 'video/mp4', bytes: Buffer.alloc(100, 7), grants: ['vault'] }
    }
  });
  try {
    await connectVault(google);

    // Executables and other non-allowlisted types are never publishable.
    await assert.rejects(
      () => googleDrive.registerFile({ fileId: EXE_ID, accessToken: 'tok' }),
      /not supported/i
    );

    // Videos must go to Bunny Stream.
    await assert.rejects(
      () => googleDrive.registerFile({ fileId: VID_ID, accessToken: 'tok' }),
      /Bunny Stream/i
    );
  } finally {
    google.restore();
  }
});

test('a Drive file the server cannot read is refused at publish, with actionable guidance', async () => {
  // 1) With no connected account at all, a PRIVATE file (invisible to the
  //    API key) must not be reported as "deleted" — the missing connection
  //    is the problem.
  const google = installFakeGoogle();
  try {
    db.prepare('DELETE FROM google_drive_accounts').run();
    await assert.rejects(
      () => googleDrive.registerFile({ fileId: DRIVE_ID, accessToken: 'ya29.picker-token' }),
      (err) => {
        assert.equal(err.statusCode, 503);
        assert.match(err.message, /not connected to Google Drive/i);
        assert.match(err.message, /Admin → Integrations/i);
        return true;
      }
    );
  } finally {
    google.restore();
  }

  // 2) With the account connected but explicitly refused (revoked per-file
  //    access), the guidance names the connection, not a deleted file.
  const refused = installFakeGoogle({
    files: { [DRIVE_ID]: { name: 'notes.pdf', mime: 'application/pdf', bytes: PDF_BYTES, grants: [], refuseVaultWith: 403 } }
  });
  try {
    await connectVault(refused);
    await assert.rejects(
      () => googleDrive.registerFile({ fileId: DRIVE_ID, accessToken: 'ya29.picker-token' }),
      (err) => {
        assert.equal(err.statusCode, 403);
        assert.match(err.message, /could not read this file/i);
        assert.match(err.message, /Admin → Integrations/i);
        assert.doesNotMatch(err.message, /request access/i);
        return true;
      }
    );
  } finally {
    refused.restore();
  }

  // 3) A file that genuinely no longer exists.
  const missing = installFakeGoogle({ files: {} });
  try {
    await connectVault(missing);
    await assert.rejects(
      () => googleDrive.registerFile({ fileId: DRIVE_ID, accessToken: 'ya29.picker-token' }),
      (err) => {
        assert.equal(err.statusCode, 404);
        assert.match(err.message, /could not be found/i);
        return true;
      }
    );
  } finally {
    missing.restore();
  }
});

test('a malformed Drive file id is rejected before any request is made', async () => {
  const google = installFakeGoogle();
  try {
    await connectVault(google);
    await assert.rejects(
      () => googleDrive.registerFile({ fileId: 'not a valid id!!', accessToken: 'tok' }),
      /not valid/i
    );
    // connectVault itself makes Drive-adjacent calls (folder lookup); what
    // must NOT happen is any per-file request for the malformed id.
    assert.equal(
      google.calls.filter((c) => /\/drive\/v3\/files\/[^?/]/.test(c.url)).length, 0,
      'no per-file Drive request is issued for a malformed id'
    );
  } finally {
    google.restore();
  }
});

// Comments explaining removed behaviour legitimately mention these URLs, so
// the assertions below run against the file with comments stripped — what
// matters is that no CODE builds a Google URL for a student.
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

test('the student viewer never embeds Google Drive or offers an access-request path', () => {
  const viewerJs = codeOnly(read('public/js/viewer.js'));

  assert.doesNotMatch(viewerJs, /drive\.google\.com/,
    'the viewer must not embed or link a drive.google.com URL');
  assert.doesNotMatch(viewerJs, /docs\.google\.com/,
    'no Google-hosted viewer is used for student documents');
  assert.doesNotMatch(viewerJs, /<iframe[^>]*drive|drive-preview-frame/,
    'the Google Drive preview iframe is what showed "Request access"');
  assert.doesNotMatch(viewerJs, /Open in Google Drive|Open Document/,
    'no "open it in Drive" escape hatch is offered to students');

  // All documents flow through the ordinary protected reader.
  assert.match(viewerJs, /StudyCoreReader\.init/);
  assert.match(viewerJs, /protectedUrl/);
});

test('the stream endpoint serves students itself and never redirects to Google', () => {
  const resourceRoutes = codeOnly(read('routes/resources.routes.js'));

  assert.doesNotMatch(resourceRoutes, /docs\.google\.com/,
    'the gview redirect handed authorization to Google');
  assert.doesNotMatch(resourceRoutes, /drive\.google\.com/);
  assert.doesNotMatch(resourceRoutes, /res\.redirect\(/,
    'a student must never be redirected off StudyCore to read a document');

  // Drive-backed rows are proxied server-side through the gated stream.
  assert.match(resourceRoutes, /driveDocumentKey/);
  assert.match(resourceRoutes, /streamDriveDocument/);
});

test('publishing a Drive file registers a reference through the server credential', () => {
  const routes = read('routes/content-admin.routes.js');
  const adminRoutes = read('routes/admin.routes.js');

  assert.match(routes, /googleDrive\.registerFile/,
    'the publish/edit routes register the Drive file');
  assert.match(adminRoutes, /googleDrive\.registerFile/,
    'the Main Admin publish/edit routes register the Drive file too');
  assert.doesNotMatch(routes, /googleDrive\.importToStorage/,
    'the copy-at-publish ("being moved into StudyCore") path is gone');
  assert.doesNotMatch(adminRoutes, /googleDrive\.importToStorage/,
    'the copy-at-publish ("being moved into StudyCore") path is gone');
  assert.doesNotMatch(routes, /googleDrive\.linkDriveFile/,
    'new code must not leave a bare Drive link without server verification');

  // The registration library no longer touches document storage: nothing is
  // written anywhere when a Drive file is picked.
  const lib = codeOnly(read('lib/google-drive.js'));
  assert.doesNotMatch(lib, /documentStorage/,
    'registering a Drive reference must not write any object');
  assert.doesNotMatch(lib, /putObject/,
    'registering a Drive reference must not copy bytes');
});

test('the Picker hands its access token to the dashboard with the picked file', () => {
  const pickerJs = read('public/js/google-picker.js');
  const dashboardJs = read('public/js/content-admin.js');

  assert.match(pickerJs, /onGoogleDriveFilePicked\(doc,\s*\{\s*accessToken/,
    'the picker passes the OAuth token with the picked file');
  assert.match(dashboardJs, /google_drive_access_token/,
    'the dashboard forwards the token so the server knows the Picker just ran');
  // The token is a credential: memory only, cleared between publishes.
  assert.match(dashboardJs, /state\.driveAccessToken = null/);
  assert.doesNotMatch(dashboardJs, /localStorage\.setItem\([^)]*[Tt]oken/);
});
