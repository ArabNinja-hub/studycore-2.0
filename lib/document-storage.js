// =============================================================================
// StudyCore — document storage dispatcher
// -----------------------------------------------------------------------------
// Single seam between "where a document's bytes actually live" and every
// caller that reads/writes them (the upload middleware, resumable uploads,
// the Google Drive picker import, and the student /stream route).
//
//   WRITES  — go to the Google Drive vault (lib/google-drive-vault.js) once a
//             Main Admin has connected an account; otherwise they fall back
//             to the pre-existing R2/local backend (lib/storage.js), exactly
//             as before Drive was ever introduced.
//   READS/DELETES — always dispatch by the object's OWN recorded backend
//             (`storage_provider` on the resources / upload_sessions row),
//             never by whatever is active today. This is what keeps every
//             already-published resource readable when the vault is connected
//             or disconnected later. The only exception is the legacy
//             'google_drive' provider, which is a fragile pre-import reference
//             kept only so old rows can still be proxied or repaired.
// =============================================================================

'use strict';

const storage = require('./storage');
const vault = require('./google-drive-vault');
const driveDocuments = require('./drive-documents');

// Three read backends, selected by the row's OWN recorded provider:
//
//   'google_drive'       — a LEGACY Drive reference: the row's stored_name or
//                          google_drive_file_id is the original uploader's
//                          Drive file id. New Picker publishes no longer use
//                          this provider because students can be sent to
//                          Google's access wall if that file's sharing changes;
//                          lib/drive-documents.js remains as a best-effort
//                          server-side proxy for old rows.
//   'google_drive_vault' — a file StudyCore itself UPLOADED into the
//                          connected vault account's folder. This includes new
//                          Drive Picker imports when the vault is configured.
//   'r2' / 'local'       — an ordinary direct upload or Drive Picker import to
//                          object storage.
function backendFor(provider) {
  if (provider === 'google_drive_vault') return vault;
  if (provider === 'google_drive') return driveDocuments;
  return storage;
}

// The backend NEW documents are written to right now.
function backendName() {
  return vault.isConfigured() ? 'google_drive_vault' : storage.backendName();
}

function isVaultActive() {
  return vault.isConfigured();
}

// `key` is only meaningful for the R2/local fallback (Drive assigns its own
// file id on write, returned in the result). `fileName` is required for the
// Drive branch so the file is not stored as "Untitled".
async function putObject({ key, body, contentType, fileName }) {
  if (vault.isConfigured()) {
    const result = await vault.putObject({ body, contentType, fileName: fileName || key });
    return { backend: 'google_drive_vault', key: result.key };
  }
  const result = await storage.putObject({ key, body, contentType });
  return { backend: result.backend, key: result.key };
}

async function headObject(key, provider) {
  return backendFor(provider).headObject(key);
}

async function getObject(key, range, provider) {
  return backendFor(provider).getObject(key, range);
}

async function readBytes(key, start, end, provider) {
  return backendFor(provider).readBytes(key, start, end);
}

async function deleteObject(key, provider) {
  if (!key) return;
  return backendFor(provider).deleteObject(key).catch((err) => {
    console.error(`[StudyCore][DocumentStorage] delete failed (${provider || 'r2/local'}):`, err.message);
  });
}

// True when the row is one of the legacy Drive references whose stored_name is
// a Drive file id, so callers can avoid treating it as a StudyCore object key.
function isDriveHosted(provider) {
  return provider === 'google_drive';
}

module.exports = {
  putObject,
  headObject,
  getObject,
  readBytes,
  deleteObject,
  backendName,
  isVaultActive,
  isDriveHosted
};
