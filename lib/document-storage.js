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

function isNotFound(err) {
  return Boolean(err) && (
    err.code === 'NoSuchKey' ||
    err.name === 'NoSuchKey' ||
    err.name === 'NotFound' ||
    err.$metadata?.httpStatusCode === 404
  );
}

// `storage_provider` was introduced after early StudyCore installations had
// already stored documents. Those rows received SQLite's default "local"
// marker even when their bytes were in R2, and the inverse can happen when a
// deployment is moved from local disk to R2. Try the recorded backend first,
// then the other *ordinary object* backend only when the key is genuinely
// absent. UUID storage keys make a cross-backend collision vanishingly
// unlikely, while this compatibility read brings the existing material back
// without ever falling back across a Google Drive boundary.
function objectBackendsFor(provider) {
  if (provider !== 'local' && provider !== 'r2') return [storage.backendName()];
  const other = provider === 'local' ? 'r2' : 'local';
  // R2 cannot be queried when its credentials are absent. Local disk is
  // always queryable, so it remains a useful recovery path for an old R2 row
  // on a restored deployment.
  return other === 'r2' && !storage.isR2Configured()
    ? [provider]
    : [provider, other];
}

async function readObjectWithCompatibilityFallback(method, args, provider) {
  const backend = backendFor(provider);
  // Google Drive-backed objects have opaque file IDs, not StudyCore object
  // keys. Never try them against local/R2, and never make a Drive vault file
  // depend on whichever ordinary storage is currently active.
  if (backend !== storage) {
    const result = await backend[method](...args);
    return { result, backend: provider };
  }

  const candidates = objectBackendsFor(provider);
  let missing = null;
  for (const candidate of candidates) {
    try {
      const result = await storage[method](...args, candidate);
      return { result, backend: candidate };
    } catch (err) {
      const unavailableR2 = candidate === 'r2' && err && err.code === 'StorageNotConfigured';
      if (!isNotFound(err) && !unavailableR2) throw err;
      missing = err;
    }
  }
  throw missing || new Error('Not found');
}

async function headObject(key, provider) {
  const found = await readObjectWithCompatibilityFallback('headObject', [key], provider);
  return { ...found.result, backend: found.backend };
}

async function getObject(key, range, provider) {
  const found = await readObjectWithCompatibilityFallback('getObject', [key, range], provider);
  return { ...found.result, backend: found.backend };
}

async function readBytes(key, start, end, provider) {
  const found = await readObjectWithCompatibilityFallback('readBytes', [key, start, end], provider);
  return found.result;
}

async function deleteObject(key, provider) {
  if (!key) return;
  const backend = backendFor(provider);
  // Deletion is intentionally NOT fail-over. A missing old R2 object must
  // never cause an unrelated local file with the same key to be removed.
  const remove = backend === storage
    ? storage.deleteObject(key, provider)
    : backend.deleteObject(key);
  return remove.catch((err) => {
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
