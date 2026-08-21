// Unified object storage for StudyCore uploads.
//
// Production path is unchanged: when Cloudflare R2 is configured, every
// object is written to / read from the existing R2 bucket via the S3 API.
// When R2 is not configured (local development, tests, first boot), files
// stream to DATA_DIR/uploads instead so the document reader and video
// player still have something real to open.
//
// Callers never buffer a whole object in memory. Range reads are first-class
// so PDFs and videos can start rendering before the rest of the file arrives.

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const {
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand
} = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { r2, bucketName } = require('./r2');

function looksConfigured(value) {
  const v = String(value || '').trim();
  if (!v) return false;
  return !/^your-|^changeme|^replace-this|^xxx+$/i.test(v);
}

const r2Configured = Boolean(
  looksConfigured(process.env.R2_ACCOUNT_ID) &&
  looksConfigured(process.env.R2_ACCESS_KEY_ID) &&
  looksConfigured(process.env.R2_SECRET_ACCESS_KEY) &&
  looksConfigured(process.env.R2_BUCKET_NAME)
);

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const LOCAL_DIR = path.join(DATA_DIR, 'uploads');

function isR2Configured() {
  return r2Configured;
}

function backendName() {
  return r2Configured ? 'r2' : 'local';
}

function safeKey(key) {
  const normalized = String(key || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('..') || path.isAbsolute(normalized)) {
    const err = new Error('Invalid storage key');
    err.code = 'InvalidKey';
    throw err;
  }
  return normalized;
}

function localPath(key) {
  return path.join(LOCAL_DIR, safeKey(key));
}

function notFound() {
  const err = new Error('Not found');
  err.code = 'NoSuchKey';
  err.name = 'NoSuchKey';
  return err;
}

async function putObject({ key, body, contentType }) {
  const k = safeKey(key);
  if (r2Configured) {
    const upload = new Upload({
      client: r2,
      params: {
        Bucket: bucketName,
        Key: k,
        Body: body,
        ContentType: contentType || 'application/octet-stream'
      }
    });
    await upload.done();
    return { backend: 'r2', key: k };
  }

  const dest = localPath(k);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (body && typeof body.pipe === 'function') {
    await pipeline(body, fs.createWriteStream(dest));
  } else if (Buffer.isBuffer(body) || typeof body === 'string') {
    await fs.promises.writeFile(dest, body);
  } else {
    throw new Error('Unsupported upload body');
  }
  return { backend: 'local', key: k };
}

async function headObject(key) {
  const k = safeKey(key);
  if (r2Configured) {
    try {
      const obj = await r2.send(new HeadObjectCommand({ Bucket: bucketName, Key: k }));
      return {
        contentLength: Number(obj.ContentLength) || 0,
        contentType: obj.ContentType || null,
        lastModified: obj.LastModified || null
      };
    } catch (err) {
      if (err.name === 'NotFound' || err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
        throw notFound();
      }
      throw err;
    }
  }

  try {
    const st = await fs.promises.stat(localPath(k));
    if (!st.isFile()) throw notFound();
    return {
      contentLength: st.size,
      contentType: null,
      lastModified: st.mtime
    };
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'NoSuchKey') throw notFound();
    throw err;
  }
}

async function getObject(key, range) {
  const k = safeKey(key);
  if (r2Configured) {
    const input = { Bucket: bucketName, Key: k };
    if (range && Number.isFinite(range.start) && Number.isFinite(range.end)) {
      input.Range = `bytes=${range.start}-${range.end}`;
    }
    try {
      const obj = await r2.send(new GetObjectCommand(input));
      return {
        body: obj.Body,
        contentLength: obj.ContentLength,
        contentType: obj.ContentType || null,
        contentRange: obj.ContentRange || null
      };
    } catch (err) {
      if (err.name === 'NoSuchKey' || err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
        throw notFound();
      }
      throw err;
    }
  }

  const filePath = localPath(k);
  let st;
  try {
    st = await fs.promises.stat(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') throw notFound();
    throw err;
  }

  const size = st.size;
  const start = range ? range.start : 0;
  const end = range ? range.end : Math.max(0, size - 1);
  const stream = size === 0
    ? Readable.from([])
    : fs.createReadStream(filePath, { start, end });

  return {
    body: stream,
    contentLength: size === 0 ? 0 : (end - start + 1),
    contentType: null,
    contentRange: range ? `bytes ${start}-${end}/${size}` : null
  };
}

async function streamToBuffer(body) {
  if (!body) return Buffer.alloc(0);
  if (typeof body.transformToByteArray === 'function') {
    return Buffer.from(await body.transformToByteArray());
  }
  const chunks = [];
  if (typeof body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  if (typeof Readable.fromWeb === 'function' && typeof body.getReader === 'function') {
    for await (const chunk of Readable.fromWeb(body)) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  return Buffer.alloc(0);
}

async function readBytes(key, start, end) {
  const obj = await getObject(key, { start, end });
  return streamToBuffer(obj.body);
}

async function deleteObject(key) {
  if (!key) return;
  const k = safeKey(key);
  if (r2Configured) {
    await r2.send(new DeleteObjectCommand({ Bucket: bucketName, Key: k }));
    return;
  }
  try {
    await fs.promises.unlink(localPath(k));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

module.exports = {
  isR2Configured,
  backendName,
  putObject,
  headObject,
  getObject,
  readBytes,
  deleteObject,
  LOCAL_DIR
};
