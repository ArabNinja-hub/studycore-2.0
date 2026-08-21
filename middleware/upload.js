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

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return cb(new Error(`File type "${ext || 'unknown'}" is not supported.`));
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
    const ext = path.extname(file.originalname).toLowerCase();
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
