'use strict';

// Regression tests for the Google Drive Picker IMPORT path and the remaining
// legacy Drive-reference fallback.
//
// THE BUG THIS PINS
//
// Drive-picked resources used to be stored as a LINK (just the Drive file id)
// and students were shown an embedded drive.google.com preview. Google checks
// the file's own sharing list, not the StudyCore session, so students who were
// not individually shared on the uploader's private file saw "Request access".
//
// The fixed publish path imports the bytes into StudyCore document storage at
// publish time. Legacy rows that already contain storage_provider='google_drive'
// are still proxied server-side when possible, but new publishes must not
// create that fragile state.

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
// Keep R2 unconfigured so imports land in the local object store, which these
// tests can inspect byte-for-byte. If a Drive vault is configured in another
// environment, document-storage will still return the correct recorded backend.
process.env.R2_ACCOUNT_ID = '';
process.env.R2_ACCESS_KEY_ID = '';
process.env.R2_SECRET_ACCESS_KEY = '';
process.env.R2_BUCKET_NAME = '';
// Server-side credential used only by the legacy google_drive fallback tests.
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
function installFakeDrive({ metadata, body = PDF_BYTES, failDownload = null } = {}) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    const method = (options && options.method) || 'GET';
    calls.push({ url: target, method, headers: (options && options.headers) || {} });

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

test('a picked Drive PDF is copied into StudyCore storage, not linked', async () => {
  const drive = installFakeDrive({
    metadata: { id: DRIVE_ID, name: 'Contract Law Notes.pdf', mimeType: 'application/pdf', size: String(PDF_BYTES.length) }
  });
  try {
    const file = await googleDrive.importToStorage({
      fileId: DRIVE_ID,
      accessToken: 'ya29.picker-token',
      fileName: 'Contract Law Notes.pdf',
      mimeType: 'application/pdf'
    });

    // The returned shape matches what multer produces, so the publish routes
    // cannot tell a Drive import from an ordinary upload.
    assert.ok(file.key, 'import produces a storage key');
    assert.match(file.key, /\.pdf$/, 'the stored object keeps a .pdf extension');
    assert.notEqual(file.key, DRIVE_ID, 'the storage key must NOT be the Drive file id');
    assert.equal(file.bucket, storage.backendName(), 'with no vault configured, imports use normal storage');
    assert.equal(file.originalname, 'Contract Law Notes.pdf');
    assert.equal(file.mimetype, 'application/pdf');
    assert.equal(file.size, PDF_BYTES.length);
    assert.ok(file.contentHash, 'a content hash is computed for duplicate detection');

    // The bytes really are in StudyCore storage now.
    const stored = await documentStorage.readBytes(file.key, 0, PDF_BYTES.length - 1, file.bucket);
    assert.deepEqual(Buffer.from(stored), PDF_BYTES, 'stored object matches the Drive file byte-for-byte');

    // The OAuth token was presented to Google, and the binary download endpoint
    // (alt=media) was used only by the server at publish time.
    const download = drive.calls.find((c) => c.url.includes('alt=media'));
    assert.ok(download, 'the file was downloaded with alt=media');
    assert.equal(download.headers.Authorization, 'Bearer ya29.picker-token');
  } finally {
    drive.restore();
  }
});

test('a legacy Drive reference can still be read server-side with Range support', async () => {
  const drive = installFakeDrive({
    metadata: { id: DRIVE_ID, name: 'notes.pdf', mimeType: 'application/pdf', size: String(PDF_BYTES.length) }
  });
  try {
    // Exactly how the stream route handles old rows: provider 'google_drive',
    // key = original Drive id. This is a compatibility fallback only.
    const head = await documentStorage.headObject(DRIVE_ID, 'google_drive');
    assert.equal(head.contentLength, PDF_BYTES.length);
    assert.equal(head.contentType, 'application/pdf');

    const full = await documentStorage.readBytes(DRIVE_ID, 0, PDF_BYTES.length - 1, 'google_drive');
    assert.deepEqual(full, PDF_BYTES, 'the legacy proxy receives the exact Drive bytes');

    // pdf.js pages a PDF in 128KB ranges — those must reach Drive as ranges.
    const ranged = await documentStorage.readBytes(DRIVE_ID, 4, 8, 'google_drive');
    assert.deepEqual(ranged, PDF_BYTES.subarray(4, 9), 'Range reads are honored end-to-end');
    const rangedCall = drive.calls.find((c) => c.headers && c.headers.Range === 'bytes=4-8');
    assert.ok(rangedCall, 'the Range header is forwarded to Google Drive');
    assert.ok(rangedCall.url.includes('alt=media'), 'legacy bytes come from the Drive media endpoint');
  } finally {
    drive.restore();
  }
});

test('deleting a legacy Drive reference never deletes the original Drive file', async () => {
  const drive = installFakeDrive({
    metadata: { id: DRIVE_ID, name: 'notes.pdf', mimeType: 'application/pdf', size: String(PDF_BYTES.length) }
  });
  try {
    await documentStorage.deleteObject(DRIVE_ID, 'google_drive');
    const deletes = drive.calls.filter((c) => c.method === 'DELETE');
    assert.equal(deletes.length, 0,
      'a legacy source document belongs to its owner in Google Drive');
  } finally {
    drive.restore();
  }
});

test('a native Google Doc is exported to PDF during import', async () => {
  const drive = installFakeDrive({
    metadata: { id: DOC_ID, name: 'Lecture 3', mimeType: 'application/vnd.google-apps.document', size: '0' }
  });
  try {
    const file = await googleDrive.importToStorage({ fileId: DOC_ID, accessToken: 'ya29.picker-token' });
    assert.equal(file.mimetype, 'application/pdf');
    assert.equal(file.originalname, 'Lecture 3.pdf', 'a .pdf extension is recorded for the reader');
    assert.notEqual(file.key, DOC_ID, 'Workspace imports still produce a StudyCore storage key');

    const exportCall = drive.calls.find((c) => c.url.includes('/export'));
    assert.ok(exportCall, 'Workspace files are imported through the Drive export endpoint');
    assert.match(exportCall.url, /mimeType=application%2Fpdf/);

    const stored = await documentStorage.readBytes(file.key, 0, file.size - 1, file.bucket);
    assert.deepEqual(Buffer.from(stored), PDF_BYTES);
  } finally {
    drive.restore();
  }
});

test('Drive imports are validated exactly like an ordinary upload', async () => {
  // Claims to be a PDF but the bytes are not — the magic-byte check must reject
  // it at publish time, same as the multipart upload path.
  const drive = installFakeDrive({
    metadata: { id: BAD_ID, name: 'fake.pdf', mimeType: 'application/pdf', size: '20' },
    body: Buffer.from('this is definitely not a pdf at all', 'utf8')
  });
  try {
    await assert.rejects(
      () => googleDrive.importToStorage({ fileId: BAD_ID, accessToken: 'tok' }),
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
      () => googleDrive.importToStorage({ fileId: EXE_ID, accessToken: 'tok' }),
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
      () => googleDrive.importToStorage({ fileId: VID_ID, accessToken: 'tok' }),
      /Bunny Stream/i
    );
  } finally {
    drive.restore();
  }
});

test('Google permission failures are reported to the admin, never to the student', async () => {
  const denied = installFakeDrive({
    metadata: { id: DRIVE_ID, name: 'notes.pdf', mimeType: 'application/pdf', size: '10' },
    failDownload: 403
  });
  try {
    await assert.rejects(
      () => googleDrive.importToStorage({ fileId: DRIVE_ID, accessToken: 'tok' }),
      (err) => {
        assert.equal(err.statusCode, 403);
        // The uploader is told to re-pick the file; nothing instructs anyone to
        // "request access", which is the student-facing failure mode being removed.
        assert.match(err.message, /Select from Google Drive/i);
        assert.doesNotMatch(err.message, /request access/i);
        return true;
      }
    );
  } finally {
    denied.restore();
  }

  const expired = installFakeDrive({
    metadata: { id: DRIVE_ID, name: 'notes.pdf', mimeType: 'application/pdf', size: '10' },
    failDownload: 401
  });
  try {
    await assert.rejects(
      () => googleDrive.importToStorage({ fileId: DRIVE_ID, accessToken: 'tok' }),
      /authorization expired/i
    );
  } finally {
    expired.restore();
  }
});

test('a malformed Drive file id is rejected before any request is made', async () => {
  const drive = installFakeDrive({ metadata: {} });
  try {
    await assert.rejects(
      () => googleDrive.importToStorage({ fileId: 'not a valid id!!', accessToken: 'tok' }),
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

  // New imports use ordinary storage; legacy google_drive rows are proxied.
  assert.match(resourceRoutes, /driveDocumentKey/);
  assert.match(resourceRoutes, /streamDriveDocument/);
});

test('publishing a Drive file imports it rather than storing a link', () => {
  const routes = read('routes/content-admin.routes.js');

  assert.match(routes, /googleDrive\.importToStorage/,
    'the publish/edit routes import the Drive file');
  assert.doesNotMatch(routes, /googleDrive\.linkDriveFile/,
    'new code must not leave the source Drive file as the student storage');
  assert.doesNotMatch(routes, /storage_provider:\s*isDriveFile\s*\?\s*'google_drive'/,
    'imported Drive files record their real storage backend');

  const lib = read('lib/google-drive.js');
  assert.match(codeOnly(lib), /documentStorage\.putObject/,
    'the Drive publish path writes imported bytes to StudyCore document storage');
});

test('the Picker hands its access token to the dashboard for the import', () => {
  const pickerJs = read('public/js/google-picker.js');
  const dashboardJs = read('public/js/content-admin.js');

  assert.match(pickerJs, /onGoogleDriveFilePicked\(doc,\s*\{\s*accessToken/,
    'the picker passes the OAuth token with the picked file');
  assert.match(dashboardJs, /google_drive_access_token/,
    'the dashboard forwards the token so the server can import the file');
  // The token is a credential: memory only, cleared between publishes.
  assert.match(dashboardJs, /state\.driveAccessToken = null/);
  assert.doesNotMatch(dashboardJs, /localStorage\.setItem\([^)]*[Tt]oken/);
});
