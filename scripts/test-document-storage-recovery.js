'use strict';

// Regression coverage for documents uploaded before storage_provider was
// reliably recorded. A document can be physically present in R2 while its old
// SQLite row says "local" (or vice versa). The reader must locate that object
// rather than falsely tell students it is missing, then report the backend it
// actually used so the stream route can repair the row.

const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const test = require('node:test');

const storage = require('../lib/storage');
const documentStorage = require('../lib/document-storage');

function noSuchKey() {
  const err = new Error('Not found');
  err.code = 'NoSuchKey';
  err.name = 'NoSuchKey';
  return err;
}

async function bodyToBuffer(body) {
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test('a legacy provider marker falls back only after its recorded backend is absent', async () => {
  const original = {
    backendName: storage.backendName,
    isR2Configured: storage.isR2Configured,
    headObject: storage.headObject,
    getObject: storage.getObject,
    readBytes: storage.readBytes,
    deleteObject: storage.deleteObject
  };
  const calls = [];
  const bytes = Buffer.from('%PDF-1.7\nrecovered object\n%%EOF');

  // Simulate R2 being configured today while the resource's historical row
  // says local. Its local object is gone, but the object is still safe in R2.
  storage.backendName = () => 'r2';
  storage.isR2Configured = () => true;
  storage.getObject = async (key, range, provider) => {
    calls.push(['get', key, provider]);
    if (provider === 'local') throw noSuchKey();
    assert.equal(provider, 'r2');
    return {
      body: Readable.from([bytes]),
      contentLength: bytes.length,
      contentType: 'application/pdf',
      contentRange: null,
      backend: 'r2'
    };
  };
  storage.headObject = async (key, provider) => {
    calls.push(['head', key, provider]);
    if (provider === 'local') throw noSuchKey();
    assert.equal(provider, 'r2');
    return { contentLength: bytes.length, contentType: 'application/pdf', lastModified: null, backend: 'r2' };
  };
  storage.readBytes = async (key, start, end, provider) => {
    calls.push(['read', key, provider]);
    if (provider === 'local') throw noSuchKey();
    assert.equal(provider, 'r2');
    return bytes.subarray(start, end + 1);
  };

  try {
    const object = await documentStorage.getObject('legacy.pdf', undefined, 'local');
    assert.equal(object.backend, 'r2', 'the actual backend is exposed for the resource-row repair');
    assert.deepEqual(await bodyToBuffer(object.body), bytes);

    const metadata = await documentStorage.headObject('legacy.pdf', 'local');
    assert.equal(metadata.backend, 'r2');
    assert.equal(metadata.contentLength, bytes.length);

    const head = await documentStorage.readBytes('legacy.pdf', 0, 3, 'local');
    assert.deepEqual(head, Buffer.from('%PDF'));

    assert.deepEqual(calls, [
      ['get', 'legacy.pdf', 'local'], ['get', 'legacy.pdf', 'r2'],
      ['head', 'legacy.pdf', 'local'], ['head', 'legacy.pdf', 'r2'],
      ['read', 'legacy.pdf', 'local'], ['read', 'legacy.pdf', 'r2']
    ]);
  } finally {
    Object.assign(storage, original);
  }
});

test('deletion remains pinned to the recorded backend and never uses recovery fallback', async () => {
  const originalDelete = storage.deleteObject;
  const calls = [];
  storage.deleteObject = async (key, provider) => { calls.push([key, provider]); };
  try {
    await documentStorage.deleteObject('legacy.pdf', 'local');
    assert.deepEqual(calls, [['legacy.pdf', 'local']],
      'resource deletion must not remove an unrelated object from another backend');
  } finally {
    storage.deleteObject = originalDelete;
  }
});
