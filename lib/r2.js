// Cloudflare R2 is S3-compatible, so we talk to it using the standard AWS S3
// SDK pointed at R2's endpoint instead of Amazon's. This is the ONLY place
// that constructs the client - everything else imports from here.
//
// Required environment variables (set these in .env locally and in Render's
// Environment tab for the live site - never commit real values to Git):
//   R2_ACCOUNT_ID        - the Cloudflare account ID (found in the R2 API
//                           token screen, or in the endpoint URL itself:
//                           https://<account-id>.r2.cloudflarestorage.com)
//   R2_ACCESS_KEY_ID      - from "Create User API Token"
//   R2_SECRET_ACCESS_KEY  - from "Create User API Token" (shown only once)
//   R2_BUCKET_NAME        - the bucket you created, e.g. studycore-uploads

const { S3Client } = require('@aws-sdk/client-s3');

const REQUIRED_VARS = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME'];

// A variable counts as configured only when it is non-empty AND not a
// placeholder copied verbatim from .env.example ("your-...", "changeme",
// "replace-this-...", "xxx..."). This is the single source of truth for
// "is R2 actually usable" - lib/storage.js imports r2Configured from here
// so the storage fallback decision and the startup guard can never drift
// apart.
function looksConfigured(value) {
  const v = String(value || '').trim();
  if (!v) return false;
  return !/^your-|^changeme|^replace-this|^xxx+$/i.test(v);
}

const r2Configured = REQUIRED_VARS.every((key) => looksConfigured(process.env[key]));

if (!r2Configured) {
  if (process.env.NODE_ENV === 'production') {
    // Production must NEVER silently fall back to local disk: a
    // misconfigured deployment would "work" while writing private student
    // documents and paid video content to an ephemeral disk that vanishes
    // on every deploy. Fail startup loudly instead.
    const missing = REQUIRED_VARS.filter((key) => !looksConfigured(process.env[key]));
    throw new Error(
      `FATAL: Cloudflare R2 must be configured in production. Missing: ${missing.join(', ')}`
    );
  }
  const missing = REQUIRED_VARS.filter((key) => !looksConfigured(process.env[key]));
  console.log('='.repeat(60));
  console.log('StudyCore: Cloudflare R2 is not configured yet.');
  console.log(`Missing: ${missing.join(', ')}`);
  console.log('Uploads will be stored on local disk (DATA_DIR/uploads)');
  console.log('until these are set in .env (locally) or in your host Environment tab.');
  console.log('='.repeat(60));
}

const bucketName = process.env.R2_BUCKET_NAME;

const r2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ACCOUNT_ID ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : undefined,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  },
  // Connection reuse matters more than anything else here: without it every
  // multipart part pays a fresh TCP + TLS handshake to R2, which on a
  // multi-part video upload adds seconds of pure latency per part. The
  // socket pool is sized for the multipart queue plus concurrent downloads.
  requestHandler: {
    connectionTimeout: 6000,   // fail fast if R2 itself is unreachable
    requestTimeout: 120000,    // a single part, not the whole upload
    httpsAgent: { keepAlive: true, maxSockets: 64 }
  },
  // A transient R2 blip should not surface to the student as a failed
  // 100MB upload; only the affected part is retried.
  maxAttempts: 5
});

module.exports = { r2, bucketName, r2Configured };
