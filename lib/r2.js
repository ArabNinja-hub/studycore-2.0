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
const missing = REQUIRED_VARS.filter((key) => !process.env[key]);

if (missing.length) {
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
  }
});

module.exports = { r2, bucketName };
