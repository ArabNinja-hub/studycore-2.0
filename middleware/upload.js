const path = require('path');
const crypto = require('crypto');
const { Transform } = require('stream');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { r2, bucketName } = require('../lib/r2');

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

// A custom multer storage engine. Multer normally either buffers the whole
// file in memory or writes it to local disk - neither is what we want here.
// Instead, this streams the incoming file straight through to R2 as it
// arrives (true streaming multipart upload, so a 250MB video is never fully
// held in this server's memory or written to Render's disk), while a small
// pass-through Transform also feeds a running SHA-256 hash so we still get
// duplicate-file detection without a second read of the data.
class R2Storage {
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

    const upload = new Upload({
      client: r2,
      params: {
        Bucket: bucketName,
        Key: key,
        Body: hashingPassThrough,
        ContentType: file.mimetype
      }
    });

    upload.done()
      .then(() => {
        cb(null, {
          key,
          size,
          contentHash: hash.digest('hex'),
          bucket: bucketName
        });
      })
      .catch((err) => cb(err));
  }

  _removeFile(req, file, cb) {
    if (!file.key) return cb(null);
    r2.send(new DeleteObjectCommand({ Bucket: bucketName, Key: file.key }))
      .then(() => cb(null))
      .catch((err) => cb(err));
  }
}

const maxMb = Number(process.env.MAX_UPLOAD_MB || 2000);

const upload = multer({
  storage: new R2Storage(),
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
  storage: new R2Storage(),
  fileFilter: avatarFileFilter,
  limits: { fileSize: AVATAR_MAX_BYTES }
});

module.exports = { upload, avatarUpload, ALLOWED_EXTENSIONS };
