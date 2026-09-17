'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

// Importing the migration exposes only its source resolver under test; the
// require.main guard guarantees that no migration or Bunny call starts here.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studycore-video-migration-'));
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATA_DIR: dataDir,
  R2_ACCOUNT_ID: '',
  R2_ACCESS_KEY_ID: '',
  R2_SECRET_ACCESS_KEY: '',
  R2_BUCKET_NAME: '',
  BUNNY_LIBRARY_ID: '',
  BUNNY_API_KEY: '',
  BUNNY_CDN_HOSTNAME: ''
});
const { readSource } = require('./migrate-videos-to-bunny');

const row = {
  id: 'res-legacy-local',
  storage_provider: 'local',
  stored_name: 'legacy.mp4'
};

function noSuchKey(message = 'Not found') {
  const err = new Error(message);
  err.code = 'NoSuchKey';
  err.name = 'NoSuchKey';
  return err;
}

function storageApi(overrides = {}) {
  return {
    LOCAL_DIR: '/var/data/uploads',
    isR2Configured: () => true,
    getLocalObject: async () => ({ body: Readable.from('local'), contentLength: 5 }),
    getObject: async () => ({ body: Readable.from('r2'), contentLength: 2 }),
    headObject: async () => ({ contentLength: 2 }),
    ...overrides
  };
}

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('legacy local source is preferred when it really exists', async () => {
  let r2Reads = 0;
  const source = await readSource(storageApi({
    getObject: async () => { r2Reads += 1; throw new Error('must not read R2'); }
  }), row);
  assert.equal(source.resolvedProvider, 'local');
  assert.equal(source.contentLength, 5);
  assert.equal(r2Reads, 0);
  source.body.destroy();
});

test('legacy local metadata falls back to the R2 object only on not-found', async () => {
  const warnings = [];
  const source = await readSource(storageApi({
    getLocalObject: async () => { throw noSuchKey(); }
  }), row, { warn: (line) => warnings.push(JSON.parse(line)) });

  assert.equal(source.resolvedProvider, 'r2');
  assert.equal(source.contentLength, 2);
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0], {
    resourceId: row.id,
    diagnostic: 'storage-provider-mismatch',
    recordedProvider: 'local',
    resolvedProvider: 'r2',
    attemptedLocalPath: '/var/data/uploads/legacy.mp4',
    r2Key: 'legacy.mp4',
    localError: { code: 'NoSuchKey', name: 'NoSuchKey', message: 'Not found' }
  });
  source.body.destroy();
});

test('dry-run source verification uses R2 HEAD and never opens the object body', async () => {
  let headCalls = 0;
  let getCalls = 0;
  const source = await readSource(storageApi({
    getLocalObject: async () => { throw noSuchKey(); },
    headObject: async () => { headCalls += 1; return { contentLength: 946488176 }; },
    getObject: async () => { getCalls += 1; throw new Error('dry run must not GET R2'); }
  }), row, { metadataOnly: true, warn: () => {} });

  assert.equal(source.resolvedProvider, 'r2');
  assert.equal(source.contentLength, 946488176);
  assert.equal(headCalls, 1);
  assert.equal(getCalls, 0);
});

test('permission and I/O errors do not fall back to another backend', async () => {
  let r2Reads = 0;
  const denied = new Error('permission denied');
  denied.code = 'EACCES';
  await assert.rejects(() => readSource(storageApi({
    getLocalObject: async () => { throw denied; },
    getObject: async () => { r2Reads += 1; return {}; }
  }), row), (err) => err === denied);
  assert.equal(r2Reads, 0);
});

test('missing in both places reports both exact attempted locations', async () => {
  await assert.rejects(() => readSource(storageApi({
    getLocalObject: async () => { throw noSuchKey(); },
    getObject: async () => { throw noSuchKey('R2 key does not exist'); }
  }), row), (err) => {
    assert.match(err.message, /\/var\/data\/uploads\/legacy\.mp4/);
    assert.match(err.message, /R2 key "legacy\.mp4"/);
    assert.match(err.message, /R2 key does not exist/);
    return true;
  });
});
