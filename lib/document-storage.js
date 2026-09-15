// =============================================================================
// StudyCore — document storage dispatcher
// -----------------------------------------------------------------------------
// Single seam between "where a document's bytes actually live" and every
// caller that reads/writes them (the upload middleware, resumable uploads,
// the Google Drive Picker import, and the student /stream route).
//
//   WRITES  — ALWAYS go to StudyCore's own object storage (lib/storage.js:
//             Cloudflare R2 when configured, otherwise the local DATA_DIR
//             fallback). Google Drive is NOT a StudyCore storage backend and
//             is never the destination of an upload. A document uploaded
//             through "Upload Document" is a plain StudyCore upload; a
//             document chosen through "Select from Google Drive" is COPIED
//             out of Drive once at publish time and then written here too.
//             Nothing StudyCore stores is ever pushed back into anybody's
//             Google Drive.
//   READS/DELETES — dispatch by the object's OWN recorded backend
//             (`storage_provider` on the resources / upload_sessions row),
//             never by whatever is active today. This keeps every
//             already-published resource readable, including historical rows
//             written while an older build used a connected Drive account as
//             a storage vault ('google_drive_vault'), and legacy
//             'google_drive' reference rows that were never imported.
// =============================================================================

'use strict';

const storage = require('./storage');
const vault = require('./google-drive-vault');
const driveDocuments = require('./drive-documents');

// Three read backends, selected by the row's OWN recorded provider. Only the
// last of them is ever WRITTEN to — the two Drive ones exist so historical
// rows keep opening:
//
//   'google_drive'       — a LEGACY Drive reference: the row's stored_name or
//                          google_drive_file_id is the original uploader's
//                          Drive file id and the bytes were never imported.
//                          lib/drive-documents.js proxies those reads
//                          server-side so the student still never touches
//                          Google. Never produced by a new publish.
//   'google_drive_vault' — a file an older build uploaded into a connected
//                          Google account's "StudyCore Documents" folder while
//                          Drive was (wrongly) used as a storage backend.
//                          lib/google-drive-vault.js still reads those rows so
//                          nothing published then is lost. Never produced by a
//                          new publish.
//   'r2' / 'local'       — StudyCore's own object storage. This is where every
//                          new document goes: ordinary uploads AND files
//                          imported from the Google Drive Picker.
function backendFor(provider) {
  if (provider === 'google_drive_vault') return vault;
  if (provider === 'google_drive') return driveDocuments;
  return storage;
}

// The backend NEW documents are written to. Always StudyCore's own storage:
// Google Drive is a SOURCE you import from, never a destination StudyCore
// writes to.
function backendName() {
  return storage.backendName();
}

// Whether a Google account is connected for Drive Picker imports. It is NOT a
// storage backend — the name is kept because existing callers/tests read it,
// but it no longer influences where any byte is written.
function isVaultActive() {
  return vault.isConfigured();
}

// Writes go to StudyCore object storage, full stop. `fileName` is accepted
// (and ignored here) so the Drive import path and the upload middleware can
// share one call shape.
async function putObject({ key, body, contentType }) {
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
