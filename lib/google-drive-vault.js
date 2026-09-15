// =============================================================================
// StudyCore — connected Google Drive ACCOUNT (server-side Drive access)
// -----------------------------------------------------------------------------
// WHAT THIS IS — AND WHAT IT IS NOT
//
// Google Drive is StudyCore's document SOURCE LIBRARY, not its storage. An
// admin organises their notes, tutorials, past papers and lab reports in
// their own Drive and uses "Select from Google Drive" (the Drive Picker) to
// register one as a StudyCore resource. The resource keeps pointing at the
// original Drive file; when a student opens it, the BACKEND reads the file
// with THIS connection's credentials and streams it through the protected
// /api/resources/:id/stream endpoint (see lib/drive-documents.js and
// lib/google-drive.js).
//
// This module is the server-side Drive connection behind that: one Main Admin
// connects ONE Google account, and StudyCore stores an encrypted refresh
// token so the server can talk to Drive on its own behalf — minting
// short-lived access tokens that are cached in-process. It is also used to
// read rows written by an older build that used this account as a storage
// vault (storage_provider = 'google_drive_vault').
//
// It is NO LONGER a write destination. `putObject` is retained only so those
// historical rows share one interface with lib/storage.js; nothing in the
// current upload or import path calls it, and lib/document-storage.js always
// writes to R2/local. StudyCore never saves an upload into anybody's Google
// Drive.
//
// THE OAUTH CONNECTION
//
//   * "Connect Google Drive" (`getAuthUrl` / `handleCallback`) uses the SAME
//     GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET credentials as the Picker, with
//     the same non-restricted `drive.file` scope. There is no second Google
//     integration.
//   * `access_type=offline` returns a REFRESH token, encrypted at rest
//     (AES-256-GCM, key derived from JWT_SECRET — the same derivation pattern
//     as lib/content-tickets.js) in the `google_drive_accounts` table. It
//     never reaches the browser, is never logged, and is never returned by
//     any API route.
//   * Students are entirely unaffected: they authenticate to StudyCore, hit
//     /api/resources/:id/stream (requireAuth + program visibility +
//     Premium/trial gating + content ticket), and receive bytes from
//     StudyCore. They never get a Drive URL, a Drive file id or a Drive
//     token, and are never redirected to drive.google.com.
//
// OPTIONAL — EXCEPT FOR DRIVE-BACKED DOCUMENTS
//
// Ordinary uploads never touch this module: with no account connected they go
// to R2/local exactly as normal. But a Google Drive-backed resource can only
// be served to students through this connection — the student stream and the
// publish-time verification both authenticate with it. With no account
// connected, publishing from Google Drive is refused with instructions to
// connect one, rather than publishing a resource no student could open.
//
// Connect the Google account that OWNS the document library: the `drive.file`
// per-file access granted when a file is picked with the Picker (same client
// id) is what lets this server-side connection read it afterwards.
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

// The scope every server-side read depends on. Google echoes the scopes a
// token actually carries in both the code-exchange and the refresh response,
// so a connection consented under a narrower/older set can be detected
// instead of surfacing later as an unexplained 403 in the student viewer.
function grantedScopes(tokenJson) {
  return String((tokenJson && tokenJson.scope) || '')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Google returns the scope list only on some responses; an ABSENT scope field
// is not evidence of a missing grant, so only an explicit list that lacks
// drive.file counts as a failure.
function scopeIsUsable(tokenJson) {
  const scopes = grantedScopes(tokenJson);
  if (!scopes.length) return true;
  return scopes.includes(SCOPE) ||
    scopes.includes('https://www.googleapis.com/auth/drive') ||
    scopes.includes('https://www.googleapis.com/auth/drive.readonly');
}

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

  // A connection consented WITHOUT drive.file can mint tokens all day and
  // still fail every files.get the viewer makes. Refuse it at connect time,
  // where the admin is present and can re-consent, rather than letting it
  // become a "Document unavailable" for students later.
  if (!scopeIsUsable(tokenJson)) {
    const err = new Error(
      'That Google account did not grant StudyCore permission to read Drive files. ' +
      'Please connect again and leave the Google Drive permission ticked.'
    );
    err.statusCode = 403;
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

// Drop the in-process token so the next read mints a fresh one. Called when
// Google rejects the cached token (401/invalid credentials): the cached value
// is provably dead, and keeping it would fail every subsequent student read
// for the rest of its nominal ~55-minute lifetime.
function invalidateAccessToken(token) {
  if (!cachedToken) return;
  // Only discard the exact token that was refused. Concurrent student reads
  // may already have replaced it with a good one, and clearing that would
  // stampede the token endpoint for no reason.
  if (token && cachedToken.accessToken !== token) return;
  cachedToken = null;
}

/**
 * A short-lived Drive access token for the connected account.
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.forceRefresh] Ignore the in-process cache and mint a
 *   new token from the refresh token. Used to recover from a token Google has
 *   revoked before its nominal expiry (password change, session revoke,
 *   re-consent), which is otherwise indistinguishable from lost file access.
 */
async function getAccessToken({ forceRefresh = false } = {}) {
  const account = getAccount();
  if (!account) {
    const err = new Error('Google Drive is not connected. Ask a Main Admin to connect it in Admin → Integrations.');
    err.statusCode = 503;
    err.userSafe = true;
    throw err;
  }

  if (!forceRefresh &&
      cachedToken && cachedToken.accountId === account.id && cachedToken.expiresAt > Date.now() + 30000) {
    return cachedToken.accessToken;
  }

  const clientId = String(process.env.GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) {
    const err = new Error(
      'StudyCore\'s Google Drive credentials are not configured on the server, so Drive documents cannot be opened. ' +
      'Ask a Main Admin to set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.'
    );
    err.statusCode = 503;
    err.userSafe = true;
    throw err;
  }

  // The refresh token is encrypted with a key derived from JWT_SECRET. If that
  // secret was rotated, the ciphertext can no longer be opened — which is a
  // reconnect, not a Drive permission problem, and must not be reported as one.
  let refreshToken;
  try {
    refreshToken = decrypt(account.encrypted_refresh_token);
  } catch {
    cachedToken = null;
    const err = new Error(
      'StudyCore\'s stored Google Drive credentials could not be read (the server secret changed). ' +
      'Ask a Main Admin to reconnect Google Drive in Admin → Integrations.'
    );
    err.statusCode = 503;
    err.userSafe = true;
    throw err;
  }

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
    // The refresh failed, so whatever is cached cannot be trusted either.
    cachedToken = null;
    const err = new Error(
      json.error === 'invalid_grant'
        ? 'The connected Google Drive account has revoked StudyCore\'s access. Ask a Main Admin to reconnect it in Admin → Integrations.'
        : json.error === 'invalid_scope'
          // The persisted refresh token was granted under a different set of
          // scopes than StudyCore now requests (for example after a consent
          // change or client rotation). Only a fresh consent fixes it.
          ? 'StudyCore\'s Google Drive connection is out of date. Ask a Main Admin to disconnect and reconnect it in Admin → Integrations.'
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

// The "StudyCore Documents" folder in the connected account. Created on first
// connect and looked up by id thereafter. Historical only: it is where an
// older build wrote uploads. Nothing is written into it any more.
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

// LEGACY WRITE PATH — intentionally unused.
//
// Google Drive is not a StudyCore storage backend: lib/document-storage.js
// always writes to R2/local, so no upload and no Picker import reaches this
// function. It is kept so the module still satisfies the same interface as
// lib/storage.js for the historical rows it reads, and so a migration/repair
// script could round-trip one if ever needed.
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
  invalidateAccessToken,
  putObject,
  headObject,
  getObject,
  readBytes,
  deleteObject,
  backendName: () => 'google_drive_vault'
};
