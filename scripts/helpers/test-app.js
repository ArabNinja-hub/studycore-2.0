'use strict';

// Each node:test file runs in its own process and gets its own database and
// local object store. Never use a developer's database, R2 bucket or SMTP.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const http = require('node:http');
const test = require('node:test');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studycore-regression-'));
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATA_DIR: dataDir,
  JWT_SECRET: 'test-only-studycore-jwt-secret-0123456789',
  CONTENT_ADMIN_ACCESS_CODE: 'test-only-content-admin-access-code',
  ADMIN_EMAIL: '',
  ADMIN_PASSWORD: '',
  R2_ACCOUNT_ID: '',
  R2_ACCESS_KEY_ID: '',
  R2_SECRET_ACCESS_KEY: '',
  R2_BUCKET_NAME: '',
  SMTP_HOST: '',
  CORS_ALLOWED_ORIGINS: 'https://trusted.studycore.test'
});

const bcrypt = require('bcryptjs');
const db = require('../../db');
const app = require('../../server');
const storage = require('../../lib/storage');
const { createToken, COOKIE_NAME } = require('../../middleware/auth');
const passwordHash = bcrypt.hashSync('regression-password', 4);
let server;
let baseUrl;

test.before(async () => {
  await new Promise((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function cookieFor(user) {
  return `${COOKIE_NAME}=${createToken(user)}`;
}

async function call(method, pathname, { user, cookie, body, headers = {} } = {}) {
  const requestHeaders = { ...headers };
  if (cookie || user) requestHeaders.Cookie = cookie || cookieFor(user);
  if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
  // Node's fetch overwrites Host, which would invalidate proxy-origin tests.
  // Raw HTTP preserves the actual headers sent by a TLS-terminating proxy.
  return new Promise((resolve, reject) => {
    const request = http.request(`${baseUrl}${pathname}`, {
      method,
      headers: requestHeaders,
      signal: AbortSignal.timeout(5000)
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data;
        try { data = JSON.parse(text); } catch { data = text; }
        const responseHeaders = new Headers();
        for (const [name, values] of Object.entries(response.headers)) {
          for (const value of Array.isArray(values) ? values : [values]) responseHeaders.append(name, value);
        }
        resolve({ status: response.statusCode, headers: responseHeaders, data, text });
      });
    });
    request.on('error', reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function createUser(overrides = {}) {
  const id = `user-${randomUUID()}`;
  const row = {
    id,
    name: 'Regression Student',
    email: `${id}@studycore.test`,
    password: passwordHash,
    role: 'student',
    program_code: 'LAW',
    subscription: 'premium',
    trial_end: new Date(Date.now() + 86400000).toISOString(),
    subscription_end: new Date(Date.now() + 86400000).toISOString(),
    created_at: new Date().toISOString(),
    ...overrides
  };
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, program_code, subscription, trial_end, subscription_end, created_at)
    VALUES (@id, @name, @email, @password, @role, @program_code, @subscription, @trial_end, @subscription_end, @created_at)
  `).run(row);
  return row;
}

// Columns a test may set on a fixture resource. The INSERT is built from the
// keys actually supplied so a test can pin behaviour that depends on any of
// them (e.g. `semester`, which drives the Term 1/2/3 video grouping) without
// every caller having to spell out the full column list.
const RESOURCE_COLUMNS = [
  'id', 'title', 'description', 'category', 'resource_type', 'subject', 'course', 'course_id',
  'target_all', 'topic', 'year_level', 'semester', 'tags', 'file_name', 'stored_name',
  'file_size', 'mime_type', 'content_hash', 'external_url', 'quiz_data', 'due_date',
  'is_premium', 'pinned', 'publish_status', 'uploaded_by', 'uploader_role', 'uploader_name',
  'uploader_email', 'uploaded_at', 'created_at', 'updated_at', 'storage_provider',
  'google_drive_file_id', 'google_drive_url', 'stream_uid', 'stream_status', 'stream_duration'
];

function createResource(overrides = {}, programs = []) {
  const id = `resource-${randomUUID()}`;
  const now = new Date().toISOString();
  const row = {
    id,
    title: id,
    category: 'document',
    subject: 'Mathematics',
    course_id: null,
    target_all: 1,
    is_premium: 1,
    publish_status: 'published',
    quiz_data: null,
    file_name: null,
    stored_name: null,
    file_size: null,
    mime_type: null,
    created_at: now,
    updated_at: now,
    ...overrides
  };
  const unknown = Object.keys(row).filter((key) => !RESOURCE_COLUMNS.includes(key));
  if (unknown.length) throw new Error(`createResource: unknown column(s) ${unknown.join(', ')}`);
  const columns = Object.keys(row);
  db.prepare(`
    INSERT INTO resources (${columns.join(', ')})
    VALUES (${columns.map((c) => `@${c}`).join(', ')})
  `).run(row);
  const insert = db.prepare('INSERT INTO resource_programs (resource_id, program_code) VALUES (?, ?)');
  for (const program of programs) insert.run(row.id, program);
  return row;
}

module.exports = { app, db, storage, call, createUser, createResource, cookieFor, baseUrl: () => baseUrl };
