const path = require('path');
const crypto = require('crypto');
const { Transform } = require('stream');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const storage = require('../lib/storage');

// NOTE: .svg / image/svg+xml are deliberately NOT in the allowlist.
// StudyCore has no feature that requires user-uploaded SVG (icons are
// generated in app code, never uploaded), and a same-origin SVG can carry
// active content (<script>, <foreignObject>, onload handlers) which would
// execute as stored XSS the moment a resource or quiz image is rendered.
// If a legitimate SVG requirement ever appears, it must be sanitized before
// being stored or served.
const ALLOWED_EXTENSIONS = new Set([
  '.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.txt', '.csv',
  '.zip', '.rar',
  '.jpg', '.jpeg', '.png', '.gif', '.webp',
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
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'video/x-msvideo': '.avi',
  'video/x-matroska': '.mkv'
};

// ---------------------------------------------------------------------------
// Upload size limits
//
// The limit is an operator-tunable value (MAX_UPLOAD_MB) but it is BOUNDED:
// an invalid or missing value falls back to a safe document-sized default,
// and no value can ever exceed the hard cap. This endpoint stores
// documents, images and audio in R2 - large lecture videos are expected to
// move to Cloudflare Stream, so the default stays document-sized and the
// cap prevents an accidental (or hostile) env value from turning the upload
// path into an unbounded disk/memory sink.
// ---------------------------------------------------------------------------
const DEFAULT_MAX_UPLOAD_MB = 200;
const HARD_MAX_UPLOAD_MB = 2048;

function resolveMaxUploadMb() {
  const raw = Number(process.env.MAX_UPLOAD_MB);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_MAX_UPLOAD_MB;
  return Math.min(Math.floor(raw), HARD_MAX_UPLOAD_MB);
}

// Magic-byte (file signature) validation. The browser-provided MIME type and
// the file extension are NOT trusted on their own - after the stream lands,
// the first bytes of the real object are compared against the signature of
// the stored extension. A mismatch means the object is deleted and the
// upload rejected.
//
// Each entry: { bytes: [...] at offset 0, bytes2?: [...] at offset2, min: bytes needed }
const SIGNATURES = {
  // PDF
  pdf: { bytes: [0x25, 0x50, 0x44, 0x46], min: 4 },
  // JPEG
  jpeg: { bytes: [0xff, 0xd8, 0xff], min: 3 },
  // PNG
  png: { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], min: 8 },
  // GIF87a / GIF89a
  gif: { bytes: [0x47, 0x49, 0x46, 0x38], min: 4 },
  // WebP: "RIFF"....."WEBP"
  webp: { bytes: [0x52, 0x49, 0x46, 0x46], bytes2: [0x57, 0x45, 0x42, 0x50], offset2: 8, min: 12 },
  // AVI: "RIFF"....."AVI "
  avi: { bytes: [0x52, 0x49, 0x46, 0x46], bytes2: [0x41, 0x56, 0x49, 0x20], offset2: 8, min: 12 },
  // WAV: "RIFF"....."WAVE"
  wav: { bytes: [0x52, 0x49, 0x46, 0x46], bytes2: [0x57, 0x41, 0x56, 0x45], offset2: 8, min: 12 },
  // MP4 / MOV: ISO-BMFF "ftyp" brand at offset 4
  mp4: { bytes: [0x66, 0x74, 0x79, 0x70], offset: 4, min: 8 },
  mov: { bytes: [0x66, 0x74, 0x79, 0x70], offset: 4, min: 8 },
  // WebM / MKV: EBML header
  webm: { bytes: [0x1a, 0x45, 0xdf, 0xa3], min: 4 },
  mkv: { bytes: [0x1a, 0x45, 0xdf, 0xa3], min: 4 },
  // MP3: ID3 tag or MPEG frame sync
  mp3: { min: 3 },
  // OLE2 compound document: legacy .doc/.xls/.ppt
  ole2: { bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], min: 8 },
  // ZIP container: .zip and the Office Open XML (.docx/.pptx/.xlsx) formats
  zip: { bytes: [0x50, 0x4b, 0x03, 0x04], min: 4 },
  // RAR
  rar: { bytes: [0x52, 0x61, 0x72, 0x21], min: 4 }
};

const EXT_TO_SIGNATURE = {
  '.pdf': 'pdf',
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.png': 'png',
  '.gif': 'gif',
  '.webp': 'webp',
  '.avi': 'avi',
  '.wav': 'wav',
  '.mp4': 'mp4',
  '.mov': 'mov',
  '.webm': 'webm',
  '.mkv': 'mkv',
  '.mp3': 'mp3',
  '.doc': 'ole2',
  '.xls': 'ole2',
  '.ppt': 'ole2',
  '.zip': 'zip',
  '.docx': 'zip',
  '.pptx': 'zip',
  '.xlsx': 'zip',
  '.rar': 'rar'
};

function matchesSignature(buf, ext) {
  const name = EXT_TO_SIGNATURE[ext];
  if (!name) return true; // text formats (.txt/.csv) have no reliable signature
  const sig = SIGNATURES[name];
  if (!sig) return true;
  if (!buf || buf.length === 0) return true; // empty object: nothing to falsify
  if (buf.length < sig.min) return true; // too short to decide - do not over-reject
  if (sig.bytes) {
    const off = sig.offset || 0;
    for (let i = 0; i < sig.bytes.length; i += 1) {
      if (buf[off + i] !== sig.bytes[i]) return false;
    }
  }
  if (sig.bytes2) {
    for (let i = 0; i < sig.bytes2.length; i += 1) {
      if (buf[sig.offset2 + i] !== sig.bytes2[i]) return false;
    }
  }
  if (name === 'mp3') {
    const id3 = buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33; // "ID3"
    const frame = buf[0] === 0xff && (buf[1] & 0xe6) === 0xe2;
    return id3 || frame;
  }
  return true;
}

function extensionFor(file) {
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
  return ext;
}

function fileFilter(req, file, cb) {
  const ext = extensionFor(file);
  if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
    const err = new Error(`File type "${ext || 'unknown'}" is not supported.`);
    err.statusCode = 400;
    err.userSafe = true;
    return cb(err);
  }
  cb(null, true);
}

// Streams the incoming file straight through to storage (R2 when configured,
// otherwise the local DATA_DIR/uploads fallback) as it arrives. A small
// pass-through Transform feeds a running SHA-256 hash so we still get
// duplicate-file detection without a second read of the data, and captures
// the first bytes for the magic-byte check. The whole object is never
// buffered in this process.
class ObjectStorage {
  _handleFile(req, file, cb) {
    const ext = extensionFor(file);
    const key = `${uuidv4()}${ext}`;
    const hash = crypto.createHash('sha256');
    let size = 0;
    const head = Buffer.alloc(16);
    let headLen = 0;

    const hashingPassThrough = new Transform({
      transform(chunk, encoding, callback) {
        hash.update(chunk);
        size += chunk.length;
        if (headLen < 16) {
          const take = Math.min(16 - headLen, chunk.length);
          chunk.copy(head, headLen, 0, take);
          headLen += take;
        }
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
        // The extension and the MIME are not enough: verify the real file
        // signature. On mismatch the object is deleted and the request
        // fails, so a renamed .html/.svg/binary cannot masquerade as a
        // document or image in the bucket.
        if (!matchesSignature(head.subarray(0, headLen), ext)) {
          return storage.deleteObject(key).then(() => {
            const err = new Error('The uploaded file does not match its file type. Please check the file and try again.');
            err.statusCode = 400;
            err.userSafe = true;
            throw err;
          });
        }
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

const maxMb = resolveMaxUploadMb();

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
    const err = new Error('Profile pictures must be PNG, JPEG or WebP files.');
    err.statusCode = 400;
    err.userSafe = true;
    return cb(err);
  }
  cb(null, true);
}

const avatarUpload = multer({
  storage: new ObjectStorage(),
  fileFilter: avatarFileFilter,
  limits: { fileSize: AVATAR_MAX_BYTES }
});

module.exports = { upload, avatarUpload, ALLOWED_EXTENSIONS, resolveMaxUploadMb };
