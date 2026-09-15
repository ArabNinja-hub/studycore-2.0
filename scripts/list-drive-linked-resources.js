// =============================================================================
// StudyCore — report legacy documents that are still LINKED to Google Drive
// -----------------------------------------------------------------------------
// New Drive Picker publishes are imported into StudyCore document storage so
// students do not depend on the uploader's private Drive sharing list. This
// script lists older rows that still carry `storage_provider = 'google_drive'`
// (or the equivalent legacy shape) and can optionally ask Google Drive whether
// StudyCore's server-side credentials can still read each original file.
//
// It only READS. Nothing is modified, copied or deleted.
//
//   Usage:
//     node scripts/list-drive-linked-resources.js            # list only
//     node scripts/list-drive-linked-resources.js --verify   # also check Drive
//
// With --verify, any document reported as UNREADABLE is one a student cannot
// open through the legacy proxy. The durable fix is to have the uploader edit
// the resource, click "Select from Google Drive", pick the same file, and save;
// that re-imports the bytes into StudyCore storage so no student is sent to
// Google's "Request access" wall.
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
  console.log('No legacy Google Drive-linked documents found.');
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
console.log(`${rows.length} legacy Google Drive-linked document(s) found (${published.length} published).`);
console.log('New Drive Picker publishes are imported into StudyCore storage; these old rows should be re-imported when possible.');
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
    console.log('To fix, in Google Drive:');
    const account = driveDocuments && driveDocuments.serviceAccountEmail();
    console.log('  · restore the file if it was deleted or trashed, and/or');
    console.log(`  · share it with ${account || 'the connected StudyCore account'} (Viewer is enough), or`);
    console.log('  · have the uploader re-select it in Content Admin → Edit → "Select from Google Drive".');
    console.log('');
    console.log('Once re-selected, StudyCore imports a stored copy so students stop seeing Drive access prompts.');
  } else if (verify) {
    console.log('All legacy Google Drive-linked documents are readable by StudyCore right now. Re-import them when convenient to remove the Drive dependency.');
  }
}

main().catch((err) => {
  console.error('Report failed:', err.message);
  process.exit(1);
});
