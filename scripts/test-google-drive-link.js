'use strict';

// Regression tests for GOOGLE DRIVE AS THE DOCUMENT STORAGE.
//
// THE ARCHITECTURE THESE PIN
//
//     Google Drive -> StudyCore backend -> StudyCore document viewer
//
// NOT:
//
//     Google Drive -> StudyCore storage -> StudyCore viewer
//
// Publishing a Drive file records a REFERENCE to it (lib/google-drive.js).
// The bytes are never copied, duplicated or migrated into StudyCore storage.
// Reading one fetches it back out of Drive server-side (lib/drive-documents.js)
// and serves it through StudyCore's own protected viewer, so students never
// touch Google's permission system and are never redirected to Drive.

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
// Keep R2 unconfigured: if anything ever tried to copy bytes into StudyCore
// storage, it would land in the local object store, which these tests inspect.
process.env.R2_ACCOUNT_ID = '';
process.env.R2_ACCESS_KEY_ID = '';
process.env.R2_SECRET_ACCESS_KEY = '';
process.env.R2_BUCKET_NAME = '';
// StudyCore's own server-side Drive credential for read-through.
process.env.GOOGLE_API_KEY = 'AIzaTestServerSideKey0000000000000000000';

const storage = require('../lib/storage');
const googleDrive = require('../lib/google-drive');
const driveDocuments = require('../lib/drive-documents');
const documentStorage = require('../lib/document-storage');

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

// Minimal PDF: a valid %PDF- signature is required by the magic-byte check.
// Google Drive file ids are long URL-safe tokens; short placeholders are
// rejected by the id validator, so the fixtures use realistic ones.
const DRIVE_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
const DOC_ID = '1ZyXwVuTsRqPoNmLkJiHgFeDcBa987654';
const BAD_ID = '1BadFileIdBadFileIdBadFileId00000';
const EXE_ID = '1ExeFileIdExeFileIdExeFileId00000';
const VID_ID = '1VidFileIdVidFileIdVidFileId00000';

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

// Stands in for Google Drive. Records every request so the tests can assert
// which endpoint was called and with which credential.
function installFakeDrive({ metadata, body = PDF_BYTES, failDownload = null, failPermissions = false } = {}) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    const method = (options && options.method) || 'GET';
    calls.push({ url: target, method, headers: (options && options.headers) || {} });

    if (target.includes('/permissions')) {
      if (failPermissions) return { ok: false, status: 403, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ id: 'perm-1' }) };
    }
    if (target.includes('fields=')) {
      return { ok: true, status: 200, json: async () => metadata };
    }
    if (failDownload) {
      return { ok: false, status: failDownload, json: async () => ({}) };
    }
    const requested = (options.headers && options.headers.Range) || null;
    let bytes = body;
    const headers = new Map([['Content-Type', metadata.mimeType || 'application/pdf']]);
    if (requested) {
      const m = /bytes=(\d+)-(\d+)/.exec(requested);
      if (m) {
        bytes = body.subarray(Number(m[1]), Number(m[2]) + 1);
        headers.set('Content-Range', `bytes ${m[1]}-${m[2]}/${body.length}`);
      }
    }
    headers.set('Content-Length', String(bytes.length));
    return {
      ok: true,
      status: requested ? 206 : 200,
      headers: { get: (h) => headers.get(h) || null },
      body: webStreamOf(bytes)
    };
  };
  return {
    calls,
    restore() { global.fetch = original; }
  };
}

test.beforeEach(() => driveDocuments.forgetCaches());

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('a picked Drive PDF is REFERENCED, never copied into StudyCore storage', async () => {
  const drive = installFakeDrive({
    metadata: { id: DRIVE_ID, name: 'Contract Law Notes.pdf', mimeType: 'application/pdf', size: String(PDF_BYTES.length) }
  });
  try {
    const file = await googleDrive.linkDriveFile({
      fileId: DRIVE_ID,
      accessToken: 'ya29.picker-token',
      fileName: 'Contract Law Notes.pdf',
      mimeType: 'application/pdf'
    });

    // The returned shape matches what multer produces, so the publish routes
    // cannot tell a Drive reference from an ordinary upload...
    assert.equal(file.originalname, 'Contract Law Notes.pdf');
    assert.equal(file.mimetype, 'application/pdf');
    assert.equal(file.size, PDF_BYTES.length);

    // ...but the "storage key" IS the Drive file id and the provider says the
    // bytes live in Google Drive.
    assert.equal(file.key, DRIVE_ID, 'the Drive file id is the storage key');
    assert.equal(file.bucket, 'google_drive');
    assert.equal(file.driveHosted, true);

    // THE DECISIVE ASSERTION: nothing was written into StudyCore storage.
    const uploadsDir = path.join(dataDir, 'uploads');
    const written = fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir) : [];
    assert.equal(written.length, 0, 'no bytes may be copied into StudyCore storage');

    // No upload/export request was made — only metadata + a validation read.
    assert.equal(drive.calls.filter((c) => c.url.includes('/upload/')).length, 0);
  } finally {
    drive.restore();
  }
});

test('a referenced Drive document is read back FROM Drive, with Range support', async () => {
  const drive = installFakeDrive({
    metadata: { id: DRIVE_ID, name: 'notes.pdf', mimeType: 'application/pdf', size: String(PDF_BYTES.length) }
  });
  try {
    // Exactly how the stream route reads it: provider 'google_drive', key = id.
    const head = await documentStorage.headObject(DRIVE_ID, 'google_drive');
    assert.equal(head.contentLength, PDF_BYTES.length);
    assert.equal(head.contentType, 'application/pdf');

    const full = await documentStorage.readBytes(DRIVE_ID, 0, PDF_BYTES.length - 1, 'google_drive');
    assert.deepEqual(full, PDF_BYTES, 'the student receives the exact bytes held in Drive');

    // pdf.js pages a PDF in 128KB ranges — those must reach Drive as ranges.
    const ranged = await documentStorage.readBytes(DRIVE_ID, 4, 8, 'google_drive');
    assert.deepEqual(ranged, PDF_BYTES.subarray(4, 9), 'Range reads are honored end-to-end');
    const rangedCall = drive.calls.find((c) => c.headers && c.headers.Range === 'bytes=4-8');
    assert.ok(rangedCall, 'the Range header is forwarded to Google Drive');
    assert.ok(rangedCall.url.includes('alt=media'), 'bytes come from the Drive media endpoint');
  } finally {
    drive.restore();
  }
});

test('deleting a StudyCore resource never deletes the file from Google Drive', async () => {
  const drive = installFakeDrive({
    metadata: { id: DRIVE_ID, name: 'notes.pdf', mimeType: 'application/pdf', size: String(PDF_BYTES.length) }
  });
  try {
    await documentStorage.deleteObject(DRIVE_ID, 'google_drive');
    const deletes = drive.calls.filter((c) => c.method === 'DELETE');
    assert.equal(deletes.length, 0,
      'Drive is the source of truth — the document belongs to its owner there');
  } finally {
    drive.restore();
  }
});

test('a native Google Doc is exported to PDF ON READ, still without copying it', async () => {
  const drive = installFakeDrive({
    metadata: { id: DOC_ID, name: 'Lecture 3', mimeType: 'application/vnd.google-apps.document', size: '0' }
  });
  try {
    const file = await googleDrive.linkDriveFile({ fileId: DOC_ID, accessToken: 'ya29.picker-token' });
    assert.equal(file.mimetype, 'application/pdf');
    assert.equal(file.originalname, 'Lecture 3.pdf', 'a .pdf extension is recorded for the reader');
    assert.equal(file.key, DOC_ID, 'still just a reference to the Drive file');
    assert.equal(file.bucket, 'google_drive');

    // The export happens at READ time, against Drive.
    const exportCall = drive.calls.find((c) => c.url.includes('/export'));
    assert.ok(exportCall, 'Workspace files are read through the Drive export endpoint');
    assert.match(exportCall.url, /mimeType=application%2Fpdf/);

    // And nothing landed in StudyCore storage.
    const uploadsDir = path.join(dataDir, 'uploads');
    const written = fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir) : [];
    assert.equal(written.length, 0);
  } finally {
    drive.restore();
  }
});

test('Drive documents are validated exactly like an ordinary upload', async () => {
  // Claims to be a PDF but the bytes are not — the magic-byte check must
  // reject it at publish time, same as the multipart upload path.
  const drive = installFakeDrive({
    metadata: { id: BAD_ID, name: 'fake.pdf', mimeType: 'application/pdf', size: '20' },
    body: Buffer.from('this is definitely not a pdf at all', 'utf8')
  });
  try {
    await assert.rejects(
      () => googleDrive.linkDriveFile({ fileId: BAD_ID, accessToken: 'tok' }),
      /does not match its file type/i
    );
  } finally {
    drive.restore();
  }

  // Executables and other non-allowlisted types are never publishable.
  const exe = installFakeDrive({
    metadata: { id: EXE_ID, name: 'malware.exe', mimeType: 'application/x-msdownload', size: '10' }
  });
  try {
    await assert.rejects(
      () => googleDrive.linkDriveFile({ fileId: EXE_ID, accessToken: 'tok' }),
      /not supported/i
    );
  } finally {
    exe.restore();
  }
});

test('Drive videos are refused so they cannot bypass Bunny Stream', async () => {
  const drive = installFakeDrive({
    metadata: { id: VID_ID, name: 'lecture.mp4', mimeType: 'video/mp4', size: '100' }
  });
  try {
    await assert.rejects(
      () => googleDrive.linkDriveFile({ fileId: VID_ID, accessToken: 'tok' }),
      /Bunny Stream/i
    );
  } finally {
    drive.restore();
  }
});

test('publishing fails loudly when StudyCore cannot read the file, rather than publishing a dead document', async () => {
  // Metadata resolves for the uploader's Picker token, but StudyCore's own
  // read is refused and the sharing grant also fails.
  const original = global.fetch;
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    const auth = (options.headers && options.headers.Authorization) || '';
    if (target.includes('/permissions')) return { ok: false, status: 403, json: async () => ({}) };
    if (auth.startsWith('Bearer ya29.picker')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: DRIVE_ID, name: 'private.pdf', mimeType: 'application/pdf', size: '10' })
      };
    }
    // StudyCore's own credential (API key) cannot see it.
    return { ok: false, status: 404, json: async () => ({}) };
  };
  try {
    await assert.rejects(
      () => googleDrive.linkDriveFile({ fileId: DRIVE_ID, accessToken: 'ya29.picker-token' }),
      (err) => {
        // The admin is told how to fix it in Drive; nobody is told to
        // "request access", and no student-facing state is created.
        assert.doesNotMatch(err.message, /request access/i);
        assert.doesNotMatch(err.message, /being moved/i);
        return true;
      }
    );
  } finally {
    global.fetch = original;
  }
});

test('granting StudyCore access never makes the document public', async () => {
  // StudyCore cannot read it at first; a private reader grant is created.
  let readable = false;
  const requests = [];
  const original = global.fetch;
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    requests.push({ url: target, method: (options && options.method) || 'GET', body: options && options.body });
    if (target.includes('/permissions')) {
      readable = true;
      return { ok: true, status: 200, json: async () => ({ id: 'perm-1' }) };
    }
    const auth = (options.headers && options.headers.Authorization) || '';
    const isPicker = auth.startsWith('Bearer ya29.picker');
    if (!isPicker && !readable) return { ok: false, status: 404, json: async () => ({}) };
    if (target.includes('fields=')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: DRIVE_ID, name: 'shared.pdf', mimeType: 'application/pdf', size: String(PDF_BYTES.length) })
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: (h) => (h === 'Content-Length' ? String(PDF_BYTES.length) : 'application/pdf') },
      body: webStreamOf(PDF_BYTES)
    };
  };
  try {
    // A connected vault account is what StudyCore grants access TO.
    const vault = require('../lib/google-drive-vault');
    const realStatus = vault.status;
    const realConfigured = vault.isConfigured;
    vault.status = () => ({ connected: true, email: 'studycore-drive@example.com' });
    vault.isConfigured = () => false; // force the API-key read path
    try {
      await googleDrive.ensureServerAccess({ fileId: DRIVE_ID, accessToken: 'ya29.picker-token' });
    } finally {
      vault.status = realStatus;
      vault.isConfigured = realConfigured;
    }

    const grant = requests.find((r) => r.url.includes('/permissions'));
    assert.ok(grant, 'a permission was created');
    const payload = JSON.parse(grant.body);
    assert.equal(payload.role, 'reader', 'read-only');
    assert.equal(payload.type, 'user', 'a single named account');
    assert.equal(payload.emailAddress, 'studycore-drive@example.com');
    assert.notEqual(payload.type, 'anyone', 'the document must never be made public');
    assert.match(grant.url, /sendNotificationEmail=false/);
  } finally {
    global.fetch = original;
  }
});

test('a malformed Drive file id is rejected before any request is made', async () => {
  const drive = installFakeDrive({ metadata: {} });
  try {
    await assert.rejects(
      () => googleDrive.linkDriveFile({ fileId: 'not a valid id!!', accessToken: 'tok' }),
      /not valid/i
    );
    assert.equal(drive.calls.length, 0, 'no request is issued for a malformed id');
  } finally {
    drive.restore();
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

test('the student viewer never embeds Google Drive, and has no "being moved" state', () => {
  const viewerJs = codeOnly(read('public/js/viewer.js'));

  // The access wall came from these URLs. None may be constructed in the
  // student's reader again.
  assert.doesNotMatch(viewerJs, /drive\.google\.com/,
    'the viewer must not embed or link a drive.google.com URL');
  assert.doesNotMatch(viewerJs, /docs\.google\.com/,
    'no Google-hosted viewer is used for student documents');
  assert.doesNotMatch(viewerJs, /<iframe[^>]*drive|drive-preview-frame/,
    'the Google Drive preview iframe is what showed "Request access"');
  assert.doesNotMatch(viewerJs, /Open in Google Drive|Open Document/,
    'no "open it in Drive" escape hatch is offered to students');

  // The incorrect migration state is gone from the viewer entirely.
  const viewerRaw = read('public/js/viewer.js');
  assert.doesNotMatch(viewerRaw, /being moved into StudyCore/,
    'documents are never moved into StudyCore, so that state must not exist');
  assert.doesNotMatch(viewerJs, /driveNotMigrated/);
  assert.doesNotMatch(viewerJs, /storageProvider === 'google_drive'/,
    'a Drive-hosted document renders in the normal reader, not a special state');

  // Drive-hosted documents flow through the ordinary protected reader.
  assert.match(viewerJs, /StudyCoreReader\.init/);
  assert.match(viewerJs, /protectedUrl/);
});

test('the stream endpoint serves Drive documents itself and never redirects to Google', () => {
  const resourceRoutes = codeOnly(read('routes/resources.routes.js'));

  assert.doesNotMatch(resourceRoutes, /docs\.google\.com/,
    'the gview redirect handed authorization to Google');
  assert.doesNotMatch(resourceRoutes, /drive\.google\.com/);
  assert.doesNotMatch(resourceRoutes, /res\.redirect\(/,
    'a student must never be redirected off StudyCore to read a document');
  assert.doesNotMatch(read('routes/resources.routes.js'), /being moved into StudyCore/,
    'the incorrect migration message must be gone');

  // Drive-hosted rows are resolved and streamed from Drive.
  assert.match(resourceRoutes, /driveDocumentKey/);
  assert.match(resourceRoutes, /streamDriveDocument/);
});

test('publishing a Drive file stores a reference, and never copies it into StudyCore', () => {
  const routes = read('routes/content-admin.routes.js');

  assert.match(routes, /googleDrive\.linkDriveFile/,
    'the publish route references the Drive file');
  assert.doesNotMatch(routes, /importToStorage/,
    'nothing may copy Drive bytes into StudyCore storage');

  const lib = read('lib/google-drive.js');
  assert.doesNotMatch(codeOnly(lib), /documentStorage\.putObject/,
    'the Drive publish path must not write to StudyCore object storage');
});

test('the Picker hands its access token to the dashboard for the reference check', () => {
  const pickerJs = read('public/js/google-picker.js');
  const dashboardJs = read('public/js/content-admin.js');

  assert.match(pickerJs, /onGoogleDriveFilePicked\(doc,\s*\{\s*accessToken/,
    'the picker passes the OAuth token with the picked file');
  assert.match(dashboardJs, /google_drive_access_token/,
    'the dashboard forwards the token so the server can verify its own access');
  // The token is a credential: memory only, cleared between publishes.
  assert.match(dashboardJs, /state\.driveAccessToken = null/);
  assert.doesNotMatch(dashboardJs, /localStorage\.setItem\([^)]*[Tt]oken/);
});
