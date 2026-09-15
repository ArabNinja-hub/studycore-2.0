// =============================================================================
// StudyCore — report documents that are backed by Google Drive
// -----------------------------------------------------------------------------
// A file selected with "Select from Google Drive" is registered as a
// Google Drive-backed resource: storage_provider = 'google_drive' and the row
// points at the original Drive file. Students are served by the backend, which
// reads that file with the connected Google account's credentials.
//
// This script lists those rows (plus any older equivalent shapes) and can
// optionally ask Google Drive whether StudyCore's server-side credentials can
// still read each original file.
//
// It only READS. Nothing is modified, copied or deleted.
//
//   Usage:
//     node scripts/list-drive-linked-resources.js            # list only
//     node scripts/list-drive-linked-resources.js --verify   # also check Drive
//
// With --verify, any document reported as UNREADABLE is one a student cannot
// open right now. The fix is in Google Drive or the connection, not in
// StudyCore: restore the file if it was deleted/trashed, or check that the
// connected account (Admin → Integrations) is the one whose library holds it.
// =============================================================================

'use strict';

const db = require('../db');

const verify = process.argv.includes('--verify');

const rows = db.prepare(`
  SELECT r.id, r.title, r.publish_status, r.storage_provider,
         r.google_drive_file_id, r.stored_name, r.mime_type, r.uploaded_at, r.created_at,
         r.subject, r.course,
         u.name AS uploader_name, u.email AS uploader_email
  FROM resources r
  LEFT JOIN users u ON u.id = r.uploaded_by
  WHERE r.storage_provider = 'google_drive'
     OR (r.google_drive_file_id IS NOT NULL AND (r.storage_provider IS NULL OR r.storage_provider = 'local')
         AND (r.stored_name IS NULL OR r.stored_name = r.google_drive_file_id))
  ORDER BY COALESCE(r.uploaded_at, r.created_at) DESC
`).all();

if (!rows.length) {
  console.log('No Google Drive-backed documents found.');
  process.exit(0);
}

// Same resolution order the stream route uses, so this reports on exactly the
// reference a student's request would follow.
function driveKeyFor(row) {
  for (const candidate of [row.google_drive_file_id, row.stored_name]) {
    const value = String(candidate || '').trim();
    if (value && /^[A-Za-z0-9_-]{5,256}$/.test(value)) return value;
  }
  return null;
}

const published = rows.filter((r) => r.publish_status === 'published');

console.log('');
console.log(`${rows.length} Google Drive-backed document(s) found (${published.length} published).`);
console.log('These resources are served by the StudyCore backend, which reads the original file from Drive with the connected account.');
console.log('');

async function main() {
  let driveDocuments = null;
  if (verify) {
    driveDocuments = require('../lib/drive-documents');
    if (!driveDocuments.hasServerCredentials()) {
      console.log('Cannot verify: StudyCore has no Google Drive credentials configured.');
      console.log('Connect an account in Admin → Integrations (or set GOOGLE_API_KEY), then re-run.');
      console.log('');
    } else {
      const account = driveDocuments.serviceAccountEmail();
      console.log(`Verifying against Google Drive as: ${account || 'API key only'}`);
      console.log('');
    }
  }

  const byUploader = new Map();
  for (const row of rows) {
    const key = row.uploader_email || 'unknown uploader';
    if (!byUploader.has(key)) byUploader.set(key, []);
    byUploader.get(key).push(row);
  }

  const unreadable = [];

  for (const [email, items] of byUploader) {
    const name = items[0].uploader_name || 'Unknown';
    console.log(`${name} <${email}> — ${items.length} document(s)`);
    for (const row of items) {
      const where = [row.course, row.subject].filter(Boolean).join(' / ');
      const driveId = driveKeyFor(row);
      console.log(`   · [${row.publish_status}] ${row.title}${where ? `  (${where})` : ''}`);
      console.log(`     id=${row.id}  driveFileId=${driveId || 'MISSING'}`);

      if (!driveId) {
        unreadable.push({ row, reason: 'no usable Google Drive file id on the record' });
        console.log('     status: NO DRIVE REFERENCE — this row cannot be resolved to a Drive file');
        continue;
      }
      if (!verify || !driveDocuments || !driveDocuments.hasServerCredentials()) continue;

      try {
        const meta = await driveDocuments.getMetadata(driveId, { fresh: true });
        console.log(`     status: READABLE — "${meta.name}" (${meta.contentType}${meta.size ? `, ${meta.size} bytes` : ''})`);
      } catch (err) {
        unreadable.push({ row, reason: err.message });
        console.log(`     status: UNREADABLE — ${err.message}`);
      }
    }
    console.log('');
  }

  if (verify && unreadable.length) {
    console.log('---');
    console.log(`${unreadable.length} document(s) cannot be read from Google Drive right now.`);
    console.log('To fix, in Google Drive / StudyCore:');
    const account = driveDocuments && driveDocuments.serviceAccountEmail();
    console.log('  · restore the file in Drive if it was deleted or trashed, and/or');
    console.log(`  · check that the connected account${account ? ` (${account})` : ''} in Admin → Integrations is the one whose library holds the file, and/or`);
    console.log('  · re-select the file in Content Admin → Edit → "Select from Google Drive" to refresh the reference.');
    console.log('');
    console.log('Students keep seeing an honest "document unavailable" message (never a Google access prompt) until the file is readable again.');
  } else if (verify) {
    console.log('All Google Drive-backed documents are readable by StudyCore right now.');
  }
}

main().catch((err) => {
  console.error('Report failed:', err.message);
  process.exit(1);
});
