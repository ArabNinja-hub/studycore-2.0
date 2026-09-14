// =============================================================================
// StudyCore — report resources that are still LINKED to Google Drive
// -----------------------------------------------------------------------------
// Documents published before the Drive import change were never copied into
// StudyCore: the row kept only the Drive file id, and students were sent to
// Google's own preview, which asks anyone not shared on the uploader's private
// file to "Request access". Those rows cannot be read by students.
//
// This script finds them so they can be fixed. It only READS the database —
// nothing is modified, deleted or re-published.
//
// The fix for each row is a re-save by its uploader: open the Content Admin
// dashboard, Edit the resource, click "Select from Google Drive", pick the same
// file, and Save. That runs the import and turns it into a normal StudyCore
// document. The import needs the uploader's own Google authorization, which is
// why it cannot be done for them from here.
//
//   Usage: node scripts/list-drive-linked-resources.js
// =============================================================================

'use strict';

const db = require('../db');

const rows = db.prepare(`
  SELECT r.id, r.title, r.publish_status, r.storage_provider,
         r.google_drive_file_id, r.uploaded_at, r.created_at,
         r.subject, r.course,
         u.name AS uploader_name, u.email AS uploader_email
  FROM resources r
  LEFT JOIN users u ON u.id = r.uploaded_by
  WHERE r.google_drive_file_id IS NOT NULL
    AND r.storage_provider = 'google_drive'
  ORDER BY COALESCE(r.uploaded_at, r.created_at) DESC
`).all();

if (!rows.length) {
  console.log('No Drive-linked resources found — every document is stored in StudyCore.');
  process.exit(0);
}

const published = rows.filter((r) => r.publish_status === 'published');

console.log('');
console.log(`Found ${rows.length} resource(s) still linked to Google Drive.`);
console.log(`${published.length} of them are PUBLISHED, so students currently see`);
console.log('Google\'s "Request access" page instead of the document.');
console.log('');

const byUploader = new Map();
for (const row of rows) {
  const key = row.uploader_email || 'unknown uploader';
  if (!byUploader.has(key)) byUploader.set(key, []);
  byUploader.get(key).push(row);
}

for (const [email, items] of byUploader) {
  const name = items[0].uploader_name || 'Unknown';
  console.log(`${name} <${email}> — ${items.length} resource(s)`);
  for (const row of items) {
    const where = [row.course, row.subject].filter(Boolean).join(' / ');
    console.log(`   · [${row.publish_status}] ${row.title}${where ? `  (${where})` : ''}`);
    console.log(`     id=${row.id}  driveFileId=${row.google_drive_file_id}`);
  }
  console.log('');
}

console.log('To fix: each uploader opens the Content Admin dashboard → Edit the');
console.log('resource → "Select from Google Drive" → pick the same file → Save.');
console.log('That copies the file into StudyCore and students can read it normally.');
