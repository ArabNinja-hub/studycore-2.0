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
//             already-published resource readable when the vault is
//             connected or disconnected later — nothing is migrated in
//             place, exactly the same policy already used for the
//             R2-vs-local switch.
// =============================================================================

'use strict';

const storage = require('./storage');
const vault = require('./google-drive-vault');

// NOTE: 'google_drive' (no suffix) is a DIFFERENT, pre-existing value already
// used on legacy resource rows to mean "still linked to a Drive file that was
// never imported" (see routes/resources.routes.js's `driveLinkedLegacy`
// check and scripts/list-drive-linked-resources.js). This vault is a real,
// working storage backend, so it deliberately uses 'google_drive_vault' to
// avoid ever being mistaken for that broken legacy state.
function backendFor(provider) {
  return provider === 'google_drive_vault' ? vault : storage;
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

module.exports = {
  putObject,
  headObject,
  getObject,
  readBytes,
  deleteObject,
  backendName,
  isVaultActive
};
