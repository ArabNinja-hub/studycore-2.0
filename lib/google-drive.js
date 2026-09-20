// =============================================
// StudyCore — Google Drive link sharing (additive)
// ---------------------------------------------
// This module does ONE thing: make sure a Drive file that a Content Admin
// picked through the EXISTING Google Picker carries the permission
//
//     { type: 'anyone', role: 'reader' }
//
// i.e. Drive's "General access → Anyone with the link → Viewer".
//
// Why it is needed: StudyCore never copies, moves or downloads the document.
// The student viewer embeds Drive's own preview
// (`drive.google.com/file/d/<id>/preview`, and `/api/resources/:id/stream`
// redirects to Drive as well), so a file that is still private shows
// "Request access" to every student. Granting link-reader is the minimum that
// makes the existing viewer work, and nothing else about the flow changes.
//
// Credentials: this module has NO credentials of its own and reads no
// environment variables. It is handed the Content Admin's own short-lived
// OAuth access token — the one the existing browser Picker already obtained
// under the `drive.file` scope, which grants per-file access (including
// sharing) to exactly the files that admin picked. The token is used for the
// duration of the call and is never logged, persisted, returned, or sent to
// students.
'use strict';

const API_BASE = 'https://www.googleapis.com/drive/v3/files';
const REQUEST_TIMEOUT_MS = 15000;

// Roles on an "anyone" permission that already let a student read the file.
// If any of these is present the file is link-viewable and we do nothing —
// we never downgrade (or otherwise touch) sharing an admin already set up.
const READABLE_ROLES = new Set(['reader', 'commenter', 'writer', 'fileOrganizer', 'organizer', 'owner']);

// Google reasons that mean "a Workspace/admin policy forbids link sharing".
// These are an operator problem, never a StudyCore bug, and must be reported
// to the Content Admin verbatim-ish rather than failing the upload.
const POLICY_REASONS = new Set([
  'shareOutNotPermitted',
  'sharingRateLimitExceeded',
  'publishOutNotPermitted',
  'cannotShareFile',
  'domainPolicy',
  'targetAudienceRestricted',
  'abuseDetected',
  'cannotModifyInheritedPermission'
]);

async function callDrive(url, accessToken, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, {
      method: options.method || 'GET',
      headers: Object.assign({
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json'
      }, options.headers || {}),
      body: options.body,
      signal: controller.signal
    });
  } catch (err) {
    const error = new Error(err.name === 'AbortError'
      ? 'Google Drive did not respond in time.'
      : 'Could not reach Google Drive.');
    error.driveCode = 'unreachable';
    throw error;
  } finally {
    clearTimeout(timer);
  }

  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }

  if (!response.ok) {
    const detail = (payload && payload.error) || {};
    const reason = (Array.isArray(detail.errors) && detail.errors[0] && detail.errors[0].reason) || '';
    const error = new Error(driveErrorMessage(response.status, reason, detail.message));
    error.driveCode = classify(response.status, reason);
    error.driveStatus = response.status;
    error.driveReason = reason;
    throw error;
  }
  return payload;
}

function classify(status, reason) {
  if (POLICY_REASONS.has(reason)) return 'policy';
  if (status === 401) return 'auth';
  if (status === 403) return 'policy';
  if (status === 404) return 'not-found';
  return 'failed';
}

function driveErrorMessage(status, reason, message) {
  const code = classify(status, reason);
  if (code === 'policy') {
    return 'Google Workspace policy blocks "Anyone with the link" sharing for this file'
      + (reason ? ` (${reason})` : '')
      + '. Ask your Google Workspace administrator to allow link sharing, or share the file manually as "Anyone with the link → Viewer".';
  }
  if (code === 'auth') {
    return 'Google rejected the Drive authorization (the sign-in may have expired). Select the document from Google Drive again.';
  }
  if (code === 'not-found') {
    return 'Google Drive could not find this file for the signed-in account. Select the document from Google Drive again.';
  }
  return `Google Drive refused the sharing change (HTTP ${status}${reason ? `, ${reason}` : ''})${message ? `: ${message}` : '.'}`;
}

/**
 * Ensure the file already is — or becomes — "Anyone with the link → Viewer".
 *
 * Never throws: every outcome is reported as a plain object so the caller can
 * keep the existing StudyCore flow intact and surface a warning instead.
 *
 * @param {string} fileId       the Drive file ID the Picker handed to StudyCore
 * @param {string} accessToken  the picking admin's own short-lived OAuth token
 * @returns {Promise<{ok: boolean, state: string, message?: string, code?: string}>}
 *          state is one of: 'already-shared' | 'shared' | 'skipped' | 'error'
 */
async function ensureAnyoneWithLinkReader(fileId, accessToken) {
  const id = String(fileId || '').trim();
  const token = String(accessToken || '').trim();
  if (!id) return { ok: false, state: 'skipped', code: 'no-file-id' };
  if (!token) return { ok: false, state: 'skipped', code: 'no-token' };

  try {
    // 1. Already "Anyone with the link"? Then do nothing at all.
    const listUrl = `${API_BASE}/${encodeURIComponent(id)}/permissions`
      + '?fields=permissions(id,type,role)&supportsAllDrives=true&pageSize=100';
    const listed = await callDrive(listUrl, token);
    const existing = ((listed && listed.permissions) || [])
      .find((permission) => permission && permission.type === 'anyone' && READABLE_ROLES.has(permission.role));
    if (existing) return { ok: true, state: 'already-shared' };

    // 2. Otherwise create exactly the one permission StudyCore needs.
    const createUrl = `${API_BASE}/${encodeURIComponent(id)}/permissions`
      + '?fields=id&supportsAllDrives=true';
    await callDrive(createUrl, token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'anyone', role: 'reader' })
    });
    return { ok: true, state: 'shared' };
  } catch (err) {
    // The document reference is already saved; sharing is best-effort. Log
    // admin-side (never the token) and let the caller warn the admin.
    console.warn(`StudyCore: Google Drive link sharing failed for file ${id}: ${err.message}`);
    return { ok: false, state: 'error', code: err.driveCode || 'failed', message: err.message };
  }
}

// Google Drive's own embedded preview player. Used as the playback surface
// for a video lesson a Content Admin selected from Drive instead of
// uploading to Bunny Stream — the same embed StudyCore already uses for
// Drive-backed documents (see routes/resources.routes.js and
// public/js/viewer.js). Drive's player has no scriptable API, so StudyCore's
// resume-position and watch-progress tracking do not apply to these lessons;
// students still get playback, just without those extras.
function videoEmbedUrl(fileId) {
  const id = String(fileId || '').trim();
  return id ? `https://drive.google.com/file/d/${encodeURIComponent(id)}/preview` : null;
}

module.exports = { ensureAnyoneWithLinkReader, videoEmbedUrl };
