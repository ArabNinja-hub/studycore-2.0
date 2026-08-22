const path = require('path');
const crypto = require('crypto');
const { Transform } = require('stream');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const storage = require('../lib/storage');

const ALLOWED_EXTENSIONS = new Set([
  '.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.txt', '.csv',
  '.zip', '.rar',
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg',
  '.mp4', '.mov', '.webm', '.mkv', '.avi',
  '.mp3', '.wav'
]);

const MIME_TO_EXT = {
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'video/x-msvideo': '.avi',
  'video/x-matroska': '.mkv'
};

function fileFilter(req, file, cb) {
  let ext = path.extname(file.originalname).toLowerCase();
  // Some mobile OS file pickers upload PDFs with a UUID name and no
  // extension (e.g. "9735a310-575d-469d-9fbb-1f720e13c396") but with a
  // correct mime type. Infer the extension from mime in that case so the
  // file isn't rejected and doesn't end up stored without an extension,
  // which later confuses Android's "Open with" dialog and the doc reader.
  if (!ext) {
    const mime = String(file.mimetype || '').toLowerCase().split(';')[0].trim();
    const inferred = MIME_TO_EXT[mime];
    if (inferred && ALLOWED_EXTENSIONS.has(inferred)) {
      ext = inferred;
    }
  }
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return cb(new Error(`File type "${ext || 'unknown'}\" is not supported.`));
  }
  cb(null, true);
}

// Streams the incoming file straight through to storage (R2 when configured,
// otherwise the local DATA_DIR/uploads fallback) as it arrives. A small
// pass-through Transform feeds a running SHA-256 hash so we still get
// duplicate-file detection without a second read of the data. The whole
// object is never buffered in this process.
class ObjectStorage {
  _handleFile(req, file, cb) {
    let ext = path.extname(file.originalname).toLowerCase();
    if (!ext) {
      const mime = String(file.mimetype || '').toLowerCase().split(';')[0].trim();
      const inferred = MIME_TO_EXT[mime];
      if (inferred) ext = inferred;
    }
    const key = `${uuidv4()}${ext}`;
    const hash = crypto.createHash('sha256');
    let size = 0;

    const hashingPassThrough = new Transform({
      transform(chunk, encoding, callback) {
        hash.update(chunk);
        size += chunk.length;
        callback(null, chunk);
      }
    });

    file.stream.pipe(hashingPassThrough);

    storage.putObject({
      key,
      body: hashingPassThrough,
      contentType: file.mimetype
    })
      .then(() => {
        cb(null, {
          key,
          size,
          contentHash: hash.digest('hex'),
          bucket: storage.backendName()
        });
      })
      .catch((err) => cb(err));
  }

  _removeFile(req, file, cb) {
    if (!file.key) return cb(null);
    storage.deleteObject(file.key)
      .then(() => cb(null))
      .catch((err) => cb(err));
  }
}

const maxMb = Number(process.env.MAX_UPLOAD_MB || 2000);

const upload = multer({
  storage: new ObjectStorage(),
  fileFilter,
  limits: { fileSize: maxMb * 1024 * 1024 }
});

// Profile pictures get their own, much stricter upload config: real images
// only (checked again by magic bytes after the stream lands - see
// routes/auth.routes.js) and a 4MB cap so the avatar pipeline can't be used
// to stash large or non-image files in the same bucket as course content.
const AVATAR_MAX_BYTES = 4 * 1024 * 1024;
const AVATAR_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

function avatarFileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!AVATAR_EXTENSIONS.has(ext)) {
    return cb(new Error('Profile pictures must be PNG, JPEG or WebP files.'));
  }
  cb(null, true);
}

const avatarUpload = multer({
  storage: new ObjectStorage(),
  fileFilter: avatarFileFilter,
  limits: { fileSize: AVATAR_MAX_BYTES }
});

module.exports = { upload, avatarUpload, ALLOWED_EXTENSIONS };
