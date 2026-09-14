// =============================================================================
// StudyCore — Google Drive VAULT (documents live IN Google Drive)
// -----------------------------------------------------------------------------
// WHAT CHANGED AND WHY
//
// StudyCore used to IMPORT a Drive file: copy its bytes once into StudyCore's
// own object storage (R2 / local disk) so students never touched Google's
// permission system. That fixed the original bug ("students who were not
// individually shared on the uploader's private file got Google's
// 'Request access' wall") but it also meant Drive was only ever a picker,
// never real storage.
//
// This module makes Google Drive the actual, persistent storage backend for
// every StudyCore document (past papers, notes, tutorial sheets, lab
// reports — everything except video, which stays on Bunny Stream). It keeps
// the exact same access guarantee the import fix established, by NEVER
// exposing a Drive URL, a Drive file id, or Drive sharing to a student's
// browser:
//
//   * A Main Admin connects ONE real Google account, once, via the
//     "Connect Google Drive" OAuth flow below (`getAuthUrl` / `handleCallback`).
//     That flow requests `access_type=offline` so Google returns a REFRESH
//     token, which is encrypted (AES-256-GCM, key derived from JWT_SECRET —
//     see lib/content-tickets.js for the same derivation pattern) and stored
//     in the `google_drive_accounts` table. The refresh token never reaches
//     the browser, is never logged, and is never returned by any API route.
//   * Every document upload (multipart, resumable, or the Content Admin's
//     "Select from Google Drive" picker) is written into a private
//     "StudyCore Documents" folder inside that ONE connected account, using
//     a short-lived access token minted server-side from the refresh token.
//   * Every student read goes through the existing, unchanged
//     /api/resources/:id/stream endpoint (requireAuth + program visibility +
//     Premium/trial gating + content ticket). That route fetches the bytes
//     from Drive with the vault's access token and pipes them to the student
//     — the student's browser makes a same-origin request to StudyCore and
//     never receives a Drive URL, a Drive id, or a Drive access token.
//
// Net effect: Google Drive is the storage unit (exactly what was asked for),
// but "opening a document" is still entirely gated by StudyCore's own
// login/subscription rules, because the browser never talks to Drive
// directly. This is the same non-negotiable rule the original import fix
// established — see docs/google-picker.md and scripts/test-drive-student-
// access.js — just satisfied by proxying reads instead of copying bytes.
//
// FALLBACK
//
// Until a Main Admin completes "Connect Google Drive" (Admin dashboard →
// Integrations), `isConfigured()` is false and lib/storage.js is used
// instead (R2, or local disk in development) exactly as before, so a fresh
// checkout keeps working without any Google setup. Once connected, storage.js
// is bypassed entirely for new documents.
// =============================================================================

'use strict';

const crypto = require('crypto');
const { Readable } = require('stream');
const db = require('../db');

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const FOLDER_NAME = 'StudyCore Documents';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

// ---------------------------------------------------------------------------
// Encryption at rest for the refresh token. Derived the same way
// lib/content-tickets.js derives its signing key: a labelled SHA-256 of
// JWT_SECRET, so no separate secret needs to be provisioned and a token
// ciphertext can never be confused with a session JWT or a content ticket
// signed from the same root secret.
// ---------------------------------------------------------------------------
function encryptionKey() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('FATAL: JWT_SECRET must be set to use the Google Drive vault.');
  }
  return crypto.createHash('sha256').update(`studycore:drive-vault:v1:${secret}`).digest();
}

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(payload) {
  const buf = Buffer.from(String(payload), 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------
// Connected-account record
// ---------------------------------------------------------------------------
function getAccount() {
  return db.prepare(`
    SELECT * FROM google_drive_accounts WHERE status = 'active'
    ORDER BY connected_at DESC LIMIT 1
  `).get() || null;
}

function isConfigured() {
  return Boolean(getAccount()) &&
    Boolean(String(process.env.GOOGLE_CLIENT_ID || '').trim()) &&
    Boolean(String(process.env.GOOGLE_CLIENT_SECRET || '').trim());
}

function redirectUri(req) {
  if (process.env.GOOGLE_DRIVE_REDIRECT_URI) return process.env.GOOGLE_DRIVE_REDIRECT_URI;
  // Falls back to deriving it from the live request so this works the same
  // in local dev and in production without a second env var to keep in sync.
  const proto = req.protocol;
  const host = req.get('Host');
  return `${proto}://${host}/api/admin/google-drive/callback`;
}

// Step 1 of "Connect Google Drive": send the admin to Google's consent
// screen. `access_type=offline` + `prompt=consent` are both required to
// reliably get a refresh token back (Google only issues one on the FIRST
// consent unless prompt=consent forces a fresh one every time).
function getAuthUrl(req, state) {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || '').trim();
  if (!clientId) {
    const err = new Error('GOOGLE_CLIENT_ID is not configured.');
    err.statusCode = 503;
    err.userSafe = true;
    throw err;
  }
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state: state || ''
  });
  return `${AUTH_URL}?${params.toString()}`;
}

// Step 2: exchange the authorization code Google redirected back with for
// tokens, then persist the refresh token (encrypted) and create/find the
// StudyCore Documents folder.
async function handleCallback({ code, req, userId }) {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) {
    const err = new Error('Google Drive is not configured (missing GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET).');
    err.statusCode = 503;
    err.userSafe = true;
    throw err;
  }

  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri(req),
    grant_type: 'authorization_code'
  });

  const tokenRes = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  const tokenJson = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokenJson.refresh_token) {
    const err = new Error(
      !tokenJson.refresh_token
        ? 'Google did not return a refresh token. Disconnect any prior StudyCore access at https://myaccount.google.com/permissions and try connecting again.'
        : 'Google rejected the authorization. Please try connecting again.'
    );
    err.statusCode = 502;
    err.userSafe = true;
    throw err;
  }

  const accessToken = tokenJson.access_token;

  // Identify the connected account (for display only — never used for auth).
  let email = null;
  try {
    const infoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (infoRes.ok) {
      const info = await infoRes.json();
      email = info.email || null;
    }
  } catch { /* cosmetic only */ }

  const folderId = await ensureFolder(accessToken);

  const now = new Date().toISOString();
  const id = `gda-${crypto.randomUUID()}`;
  // Only one active vault account at a time: retire any previous one so
  // reads/writes never split across two Drive accounts.
  db.prepare(`UPDATE google_drive_accounts SET status = 'replaced' WHERE status = 'active'`).run();
  db.prepare(`
    INSERT INTO google_drive_accounts
      (id, google_email, encrypted_refresh_token, folder_id, connected_by, connected_at, updated_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
  `).run(id, email, encrypt(tokenJson.refresh_token), folderId, userId || null, now, now);

  return { email, folderId };
}

function disconnect() {
  db.prepare(`UPDATE google_drive_accounts SET status = 'disconnected', updated_at = ? WHERE status = 'active'`)
    .run(new Date().toISOString());
}

function status() {
  const account = getAccount();
  if (!account) return { connected: false, email: null };
  return { connected: true, email: account.google_email || null, connectedAt: account.connected_at };
}

// ---------------------------------------------------------------------------
// Access token minting. Cached in-process for its lifetime (~55 minutes) so
// a burst of student reads does not each round-trip to Google for a token.
// ---------------------------------------------------------------------------
let cachedToken = null; // { accessToken, expiresAt, accountId }

async function getAccessToken() {
  const account = getAccount();
  if (!account) {
    const err = new Error('Google Drive is not connected. Ask a Main Admin to connect it in Admin → Integrations.');
    err.statusCode = 503;
    err.userSafe = true;
    throw err;
  }

  if (cachedToken && cachedToken.accountId === account.id && cachedToken.expiresAt > Date.now() + 30000) {
    return cachedToken.accessToken;
  }

  const clientId = String(process.env.GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || '').trim();
  const refreshToken = decrypt(account.encrypted_refresh_token);

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    const err = new Error(
      json.error === 'invalid_grant'
        ? 'The connected Google Drive account has revoked StudyCore\'s access. Ask a Main Admin to reconnect it in Admin → Integrations.'
        : 'Could not reach Google Drive. Please try again.'
    );
    err.statusCode = 502;
    err.userSafe = true;
    throw err;
  }

  cachedToken = {
    accessToken: json.access_token,
    expiresAt: Date.now() + (Number(json.expires_in) || 3500) * 1000,
    accountId: account.id
  };
  return cachedToken.accessToken;
}

async function driveFetch(url, options = {}) {
  const token = await getAccessToken();
  const headers = { ...(options.headers || {}), Authorization: `Bearer ${token}` };
  const res = await fetch(url, { ...options, headers });
  return res;
}

function driveError(message, statusCode = 502) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.userSafe = true;
  return err;
}

// The one folder every document is written into. Created on first connect;
// looked up by id thereafter, so a renamed/moved folder in Drive UI does not
// break anything.
async function ensureFolder(accessToken) {
  const query = encodeURIComponent(`name = '${FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  const listRes = await fetch(`${DRIVE_API}/files?q=${query}&fields=files(id,name)&spaces=drive`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (listRes.ok) {
    const listJson = await listRes.json();
    if (listJson.files && listJson.files.length) return listJson.files[0].id;
  }
  const createRes = await fetch(`${DRIVE_API}/files?fields=id`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' })
  });
  if (!createRes.ok) throw driveError('Could not create the StudyCore Documents folder in Google Drive.');
  const createJson = await createRes.json();
  return createJson.id;
}

async function folderId() {
  const account = getAccount();
  if (account && account.folder_id) return account.folder_id;
  const token = await getAccessToken();
  const id = await ensureFolder(token);
  db.prepare('UPDATE google_drive_accounts SET folder_id = ?, updated_at = ? WHERE id = ?')
    .run(id, new Date().toISOString(), account.id);
  return id;
}

// ---------------------------------------------------------------------------
// Object storage interface — mirrors lib/storage.js (putObject/headObject/
// getObject/deleteObject/readBytes) so the upload middleware, the resumable
// pipeline and the stream route can use whichever backend is configured
// without branching on which one it is. Here, "key" is the Drive file id.
// ---------------------------------------------------------------------------

// Streams `body` into a new file inside the vault folder using Drive's
// resumable upload protocol, so a multi-hundred-MB PDF/past-paper archive
// never has to be buffered whole in this process (the same guarantee
// lib/storage.js's R2 path makes).
async function putObject({ body, contentType, fileName }) {
  const token = await getAccessToken();
  const parent = await folderId();

  const initRes = await fetch(`${DRIVE_UPLOAD_API}?uploadType=resumable&fields=id`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': contentType || 'application/octet-stream'
    },
    body: JSON.stringify({
      name: fileName || 'document',
      parents: [parent]
    })
  });
  if (!initRes.ok) {
    throw driveError('Could not start the Google Drive upload session.');
  }
  const sessionUrl = initRes.headers.get('Location');
  if (!sessionUrl) throw driveError('Google Drive did not return an upload session URL.');

  // Node's fetch requires `duplex: 'half'` to stream a body that is not a
  // simple string/Buffer. body is always a Node Readable here (from Multer,
  // the resumable assembler, or the Drive-import path), so bridge it to a
  // Web ReadableStream once.
  const webBody = Readable.toWeb(body);
  const uploadRes = await fetch(sessionUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType || 'application/octet-stream' },
    body: webBody,
    duplex: 'half'
  });
  if (!uploadRes.ok) {
    throw driveError(`Google Drive upload failed (HTTP ${uploadRes.status}).`);
  }
  const json = await uploadRes.json();
  return { backend: 'google_drive_vault', key: json.id };
}

async function headObject(key) {
  const res = await driveFetch(`${DRIVE_API}/files/${encodeURIComponent(key)}?fields=id,name,mimeType,size,modifiedTime&supportsAllDrives=true`);
  if (!res.ok) {
    if (res.status === 404) {
      const err = new Error('Not found');
      err.code = 'NoSuchKey';
      err.name = 'NoSuchKey';
      throw err;
    }
    throw driveError('Could not reach Google Drive.');
  }
  const meta = await res.json();
  return {
    contentLength: Number(meta.size) || 0,
    contentType: meta.mimeType || null,
    lastModified: meta.modifiedTime ? new Date(meta.modifiedTime) : null
  };
}

async function getObject(key, range) {
  const headers = {};
  if (range && Number.isFinite(range.start) && Number.isFinite(range.end)) {
    headers.Range = `bytes=${range.start}-${range.end}`;
  }
  const res = await driveFetch(
    `${DRIVE_API}/files/${encodeURIComponent(key)}?alt=media&supportsAllDrives=true`,
    { headers }
  );
  if (!res.ok) {
    if (res.status === 404) {
      const err = new Error('Not found');
      err.code = 'NoSuchKey';
      err.name = 'NoSuchKey';
      throw err;
    }
    throw driveError('Could not reach Google Drive.');
  }
  const contentRange = res.headers.get('Content-Range');
  const contentLength = Number(res.headers.get('Content-Length')) || undefined;
  return {
    body: Readable.fromWeb(res.body),
    contentLength,
    contentType: res.headers.get('Content-Type') || null,
    contentRange: contentRange || null
  };
}

async function streamToBuffer(body) {
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function readBytes(key, start, end) {
  const obj = await getObject(key, { start, end });
  return streamToBuffer(obj.body);
}

async function deleteObject(key) {
  if (!key) return;
  const res = await driveFetch(`${DRIVE_API}/files/${encodeURIComponent(key)}?supportsAllDrives=true`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    // Best-effort: never let a Drive delete failure block a resource delete.
    console.error(`[StudyCore][DriveVault] could not delete Drive file ${key} (HTTP ${res.status})`);
  }
}

module.exports = {
  isConfigured,
  getAuthUrl,
  handleCallback,
  disconnect,
  status,
  getAccessToken,
  putObject,
  headObject,
  getObject,
  readBytes,
  deleteObject,
  backendName: () => 'google_drive_vault'
};
