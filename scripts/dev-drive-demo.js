'use strict';

// Dev-only harness (NOT part of `npm test`).
//
// Boots the real StudyCore server against a throwaway database with a FAKE
// Google standing in for Google (OAuth token endpoint + Drive), connects a
// fake server-side Google account (the "Connect Google Drive" flow), and seeds
// two Google Drive-backed documents — one exactly as "Select from Google
// Drive" registers it, one in the older row shape a previous build wrote —
// plus a student account, so the document viewer can be opened in a real
// browser on desktop and mobile widths and checked by eye.
//
//   node scripts/dev-drive-demo.js
//
// Then sign in at /login.html with the printed credentials and open the
// printed /viewer/<id> links. Every read is served by the StudyCore backend,
// which fetches the file from the (fake) Drive with the connected account's
// credentials — students never touch Google.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const dataDir = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'studycore-drive-demo-'));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'dev-only-studycore-jwt-secret-0123456789';
process.env.CONTENT_ADMIN_ACCESS_CODE = process.env.CONTENT_ADMIN_ACCESS_CODE || 'dev-access-code';
process.env.R2_ACCOUNT_ID = '';
process.env.R2_ACCESS_KEY_ID = '';
process.env.R2_SECRET_ACCESS_KEY = '';
process.env.R2_BUCKET_NAME = '';
process.env.GOOGLE_API_KEY = 'AIzaDevFakeServerKey0000000000000000000';
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '1076280995038-devdemo.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'dev-demo-client-secret';

// ---------------------------------------------------------------------------
// A believable multi-page PDF so paging/zoom/search can be exercised for real.
// ---------------------------------------------------------------------------
function buildPdf(title, pageCount) {
  const objects = [];
  const pageIds = [];
  for (let i = 0; i < pageCount; i += 1) pageIds.push(4 + i * 2);

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  for (let i = 0; i < pageCount; i += 1) {
    const pageId = pageIds[i];
    const contentId = pageId + 1;
    const text = `${title}  —  page ${i + 1} of ${pageCount}`;
    const stream = `BT /F1 20 Tf 60 720 Td (${text.replace(/[()\\]/g, '')}) Tj ET\n` +
      `BT /F1 12 Tf 60 680 Td (Served from Google Drive through the StudyCore viewer.) Tj ET`;
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i < objects.length; i += 1) {
    if (!objects[i]) continue;
    offsets[i] = pdf.length;
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = pdf.length;
  const maxId = objects.length;
  pdf += `xref\n0 ${maxId}\n0000000000 65535 f \n`;
  for (let i = 1; i < maxId; i += 1) {
    pdf += offsets[i] !== undefined
      ? `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
      : '0000000000 65535 f \n';
  }
  pdf += `trailer\n<< /Size ${maxId} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

const OLD_FILE_ID = '1OldLegacyDriveFileId000000000000';
const NEW_FILE_ID = '1NewPickerDriveFileId00000000000';
const DRIVE_FILES = new Map([
  [OLD_FILE_ID, {
    name: 'Torts Past Paper 2019.pdf',
    mime: 'application/pdf',
    bytes: buildPdf('Torts Past Paper 2019 (published BEFORE the storage changes)', 4)
  }],
  [NEW_FILE_ID, {
    name: 'Contract Law Lecture Notes.pdf',
    mime: 'application/pdf',
    bytes: buildPdf('Contract Law Lecture Notes (published from the Drive Picker)', 6)
  }]
]);

// ---------------------------------------------------------------------------
// Fake Google. Private Drive files: released only to StudyCore's own
// server-side credential (the connected account's OAuth token, or the browser
// API key) — never to a student's browser.
// ---------------------------------------------------------------------------
const VAULT_TOKEN = 'ya29.dev-demo-server-token';
const realFetch = global.fetch;
global.fetch = async (url, options = {}) => {
  const target = String(url);

  if (target === 'https://oauth2.googleapis.com/token') {
    const body = String((options && options.body) || '');
    if (body.includes('grant_type=authorization_code')) {
      return {
        ok: true, status: 200,
        json: async () => ({ access_token: VAULT_TOKEN, refresh_token: 'dev-demo-refresh-token', expires_in: 3600 })
      };
    }
    return { ok: true, status: 200, json: async () => ({ access_token: VAULT_TOKEN, expires_in: 3600 }) };
  }
  if (target.startsWith('https://www.googleapis.com/oauth2/v2/userinfo')) {
    return { ok: true, status: 200, json: async () => ({ email: 'dev-library@example.com' }) };
  }
  if (target.includes('/files?q=')) {
    return { ok: true, status: 200, json: async () => ({ files: [{ id: 'folder-demo', name: 'StudyCore Documents' }] }) };
  }

  if (!target.startsWith('https://www.googleapis.com/drive/')) return realFetch(url, options);

  const auth = (options.headers && options.headers.Authorization) || '';
  const serverCredential = auth === `Bearer ${VAULT_TOKEN}` || target.includes(`key=${process.env.GOOGLE_API_KEY}`);
  if (!serverCredential) {
    return { ok: false, status: 404, json: async () => ({ error: { message: 'File not found' } }) };
  }
  const idMatch = target.match(/\/drive\/v3\/files\/([^?/]+)/);
  const file = DRIVE_FILES.get(idMatch ? decodeURIComponent(idMatch[1]) : null);
  if (!file) return { ok: false, status: 404, json: async () => ({}) };

  if (target.includes('fields=')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: idMatch[1], name: file.name, mimeType: file.mime, size: String(file.bytes.length) })
    };
  }

  const requested = (options.headers && options.headers.Range) || null;
  let bytes = file.bytes;
  const headers = new Map([['Content-Type', file.mime]]);
  if (requested) {
    const m = /bytes=(\d+)-(\d+)/.exec(requested);
    if (m) {
      const start = Number(m[1]);
      const end = Math.min(Number(m[2]), file.bytes.length - 1);
      bytes = file.bytes.subarray(start, end + 1);
      headers.set('Content-Range', `bytes ${start}-${end}/${file.bytes.length}`);
    }
  }
  headers.set('Content-Length', String(bytes.length));
  console.log(`[fake-drive] ${requested ? `RANGE ${requested}` : 'FULL'} -> ${file.name} (${bytes.length} bytes)`);
  return {
    ok: true,
    status: requested ? 206 : 200,
    headers: { get: (h) => headers.get(h) || null },
    body: new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(bytes)); controller.close(); }
    })
  };
};

const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { createToken, COOKIE_NAME } = require('../middleware/auth');
const { ROLES } = require('../lib/roles');
const vault = require('../lib/google-drive-vault');
const app = require('../server');

// The "Connect Google Drive" step (Admin → Integrations): stores an encrypted
// refresh token for the fake connected account, exactly as the real flow does.
// The server only starts listening once the connection exists, so the very
// first document open is already served through it.
function connectFakeGoogleAccount() {
  return vault.handleCallback({
    code: 'dev-demo-auth-code',
    req: { protocol: 'http', get: () => 'localhost:3000' },
    userId: null
  }).then(({ email }) => {
    console.log(`[dev-drive-demo] connected Google account: ${email} (server-side reads use this)`);
  });
}

const course = db.prepare(`
  SELECT c.id, c.name FROM courses c
  JOIN program_courses pc ON pc.course_id = c.id
  WHERE pc.program_code = 'LAW' LIMIT 1
`).get();

function seedDriveResource({ title, driveFileId, fileName, legacy }) {
  const id = `res-${legacy ? 'old' : 'new'}-${uuidv4()}`;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO resources (id, title, description, category, resource_type, subject, course, course_id,
      target_all, topic, semester, file_name, stored_name, file_size, mime_type,
      is_premium, publish_status, uploaded_by, uploader_role, uploader_name, uploader_email,
      uploaded_at, created_at, updated_at, storage_provider, google_drive_file_id, google_drive_url)
    VALUES (@id, @title, @description, 'document', 'Notes', @subject, 'LAW', @course_id,
      0, 'Foundations', 'Term 1', @file_name, @stored_name, @file_size, 'application/pdf',
      0, 'published', NULL, 'content_admin', 'Alice Publisher', 'alice@example.com',
      @now, @now, @now, 'google_drive', @drive_id, @drive_url)
  `).run({
    id,
    title,
    description: legacy
      ? 'Drive-backed row in the older shape a previous build wrote. Must open normally.'
      : 'Registered with "Select from Google Drive". Must open normally.',
    subject: course ? course.name : 'Law',
    course_id: course ? course.id : null,
    file_name: fileName,
    // Legacy rows kept the Drive id in stored_name and often had no size.
    stored_name: driveFileId,
    file_size: legacy ? null : DRIVE_FILES.get(driveFileId).bytes.length,
    now,
    drive_id: legacy ? driveFileId : driveFileId,
    drive_url: `https://drive.google.com/file/d/${driveFileId}/view`
  });
  db.prepare('INSERT INTO resource_programs (resource_id, program_code) VALUES (?, ?)').run(id, 'LAW');
  return id;
}

const oldId = seedDriveResource({
  title: 'Torts Past Paper 2019 (OLD Drive document)',
  driveFileId: OLD_FILE_ID,
  fileName: 'Torts Past Paper 2019.pdf',
  legacy: true
});
const newId = seedDriveResource({
  title: 'Contract Law Lecture Notes (NEW Drive document)',
  driveFileId: NEW_FILE_ID,
  fileName: 'Contract Law Lecture Notes.pdf',
  legacy: false
});

const STUDENT_EMAIL = 'demo.student@studycore.test';
const STUDENT_PASSWORD = 'demo-password';
const student = {
  id: `student-${uuidv4()}`,
  name: 'Chanda Student',
  email: STUDENT_EMAIL,
  password: bcrypt.hashSync(STUDENT_PASSWORD, 8),
  role: ROLES.STUDENT,
  program_code: 'LAW',
  subscription: 'premium',
  trial_end: new Date(Date.now() + 30 * 86400000).toISOString(),
  subscription_end: new Date(Date.now() + 30 * 86400000).toISOString(),
  created_at: new Date().toISOString()
};
db.prepare(`
  INSERT INTO users (id, name, email, password, role, program_code, subscription, trial_end, subscription_end, created_at)
  VALUES (@id, @name, @email, @password, @role, @program_code, @subscription, @trial_end, @subscription_end, @created_at)
`).run(student);

const PORT = Number(process.env.PORT) || 3000;
connectFakeGoogleAccount().then(() => {
http.createServer(app).listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('StudyCore dev server (fake Google Drive attached)');
  console.log(`  listening on 0.0.0.0:${PORT}`);
  console.log('');
  console.log(`  student login : ${STUDENT_EMAIL} / ${STUDENT_PASSWORD}`);
  console.log(`  Drive doc (Picker-registered row) : /viewer/${newId}`);
  console.log(`  Drive doc (older row shape)       : /viewer/${oldId}`);
  console.log(`  session cookie: ${COOKIE_NAME}=${createToken(student)}`);
  console.log('');
});
}).catch((err) => {
  console.error('[dev-drive-demo] could not connect the fake Google account:', err.message);
  process.exit(1);
});
