'use strict';

// Regression tests for the Google Drive IMPORT path (lib/google-drive.js) and
// the reader behaviour that depends on it.
//
// THE BUG THIS PINS
//
// Drive-picked resources used to be stored as a LINK (just the Drive file id).
// Students were then shown an embedded drive.google.com preview, which Google
// authorizes against the file's own Drive sharing list rather than the
// StudyCore session - so any student who was not individually shared on the
// uploader's private file was sent to Google's "Request access" page.
//
// The fix copies the bytes into StudyCore's own storage at publish time, so a
// Drive document becomes an ordinary protected StudyCore resource. These tests
// assert the copy really happens, that the access wall is gone from every
// student-facing path, and that the import is validated like any other upload.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studycore-drive-'));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';
// Keep R2 unconfigured so the import lands in the local object store, which
// these tests can read back byte-for-byte.
process.env.R2_ACCOUNT_ID = '';
process.env.R2_ACCESS_KEY_ID = '';
process.env.R2_SECRET_ACCESS_KEY = '';
process.env.R2_BUCKET_NAME = '';

const storage = require('../lib/storage');
const googleDrive = require('../lib/google-drive');

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

// Stands in for Google. Records every request so the tests can assert which
// Drive endpoint was called and that the OAuth token was actually presented.
function installFakeDrive({ metadata, body = PDF_BYTES, failDownload = null }) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), headers: (options && options.headers) || {} });
    const isMetadata = String(url).includes('fields=');
    if (isMetadata) {
      return {
        ok: true,
        status: 200,
        json: async () => metadata
      };
    }
    if (failDownload) {
      return { ok: false, status: failDownload, json: async () => ({}) };
    }
    return { ok: true, status: 200, body: webStreamOf(body) };
  };
  return {
    calls,
    restore() { global.fetch = original; }
  };
}

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

    // The returned shape must match what multer produces, so the publish
    // routes cannot tell an import from an ordinary upload.
    assert.ok(file.key, 'import produces a storage key');
    assert.match(file.key, /\.pdf$/, 'the stored object keeps a .pdf extension');
    assert.notEqual(file.key, DRIVE_ID, 'the storage key must NOT be the Drive file id');
    assert.equal(file.size, PDF_BYTES.length);
    assert.equal(file.mimetype, 'application/pdf');
    assert.equal(file.originalname, 'Contract Law Notes.pdf');
    assert.ok(file.contentHash, 'a content hash is computed for duplicate detection');

    // The bytes really are in StudyCore storage now.
    const stored = await storage.readBytes(file.key, 0, PDF_BYTES.length - 1);
    assert.deepEqual(Buffer.from(stored), PDF_BYTES, 'stored object matches the Drive file byte-for-byte');

    // The OAuth token was presented to Google, and the binary download
    // endpoint (alt=media) was used.
    const download = drive.calls.find((c) => c.url.includes('alt=media'));
    assert.ok(download, 'the file was downloaded with alt=media');
    assert.equal(download.headers.Authorization, 'Bearer ya29.picker-token');
  } finally {
    drive.restore();
  }
});

test('a native Google Doc is exported to PDF instead of dead-ending', async () => {
  const drive = installFakeDrive({
    metadata: { id: DOC_ID, name: 'Lecture 3', mimeType: 'application/vnd.google-apps.document', size: '0' }
  });
  try {
    const file = await googleDrive.importToStorage({
      fileId: DOC_ID,
      accessToken: 'ya29.picker-token'
    });
    assert.equal(file.mimetype, 'application/pdf');
    assert.equal(file.originalname, 'Lecture 3.pdf', 'a .pdf extension is appended for the reader');
    const exportCall = drive.calls.find((c) => c.url.includes('/export'));
    assert.ok(exportCall, 'Workspace files use the export endpoint');
    assert.match(exportCall.url, /mimeType=application%2Fpdf/);
  } finally {
    drive.restore();
  }
});

test('Drive files are validated exactly like an ordinary upload', async () => {
  // Claims to be a PDF but the bytes are not - the magic-byte check must
  // reject it and remove the object, same as the multipart upload path.
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

  // Executables and other non-allowlisted types never reach storage.
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
        // The uploader is told to re-pick the file; nothing instructs anyone
        // to "request access", which is the failure mode being removed.
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

// Comments explaining the removed behaviour legitimately mention these URLs,
// so the assertions below are run against the file with comments stripped —
// what matters is that no CODE builds a Google URL for a student.
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

test('the student viewer no longer embeds Google Drive or asks for access', () => {
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

  // Drive-sourced documents must flow through the ordinary protected reader.
  assert.match(viewerJs, /StudyCoreReader\.init/);
  assert.match(viewerJs, /protectedUrl/);
});

test('the stream endpoint never redirects a student to Google', () => {
  const resourceRoutes = codeOnly(read('routes/resources.routes.js'));

  assert.doesNotMatch(resourceRoutes, /docs\.google\.com/,
    'the gview redirect handed authorization to Google');
  assert.doesNotMatch(resourceRoutes, /drive\.google\.com/);
  assert.doesNotMatch(resourceRoutes, /res\.redirect\(/,
    'a student must never be redirected off StudyCore to read a document');
  // Legacy rows get an honest in-app message rather than a Google bounce.
  assert.match(resourceRoutes, /being moved into StudyCore/);
});

test('publishing a Drive file imports it rather than storing a link', () => {
  const routes = read('routes/content-admin.routes.js');

  assert.match(routes, /googleDrive\.importToStorage/,
    'the publish route imports the Drive file');
  // The old code wrote the Drive file id into stored_name (not a storage key)
  // and tagged the row google_drive, which is what made it unreadable.
  assert.doesNotMatch(routes, /stored_name:\s*isDriveFile/,
    'a Drive file id must never be written into stored_name');
  assert.doesNotMatch(routes, /storage_provider:\s*isDriveFile\s*\?\s*'google_drive'/,
    'imported Drive files record their real storage backend');
});

test('the Picker hands its access token to the dashboard for the import', () => {
  const pickerJs = read('public/js/google-picker.js');
  const dashboardJs = read('public/js/content-admin.js');

  assert.match(pickerJs, /onGoogleDriveFilePicked\(doc,\s*\{\s*accessToken/,
    'the picker passes the OAuth token with the picked file');
  assert.match(dashboardJs, /google_drive_access_token/,
    'the dashboard forwards the token so the server can copy the file');
  // The token is a credential: memory only, cleared between publishes.
  assert.match(dashboardJs, /state\.driveAccessToken = null/);
  assert.doesNotMatch(dashboardJs, /localStorage\.setItem\([^)]*[Tt]oken/);
});
