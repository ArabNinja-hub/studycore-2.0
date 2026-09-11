'use strict';

// Unit tests for the Cloudflare Stream integration helpers (lib/stream.js).
// These exercise config detection and browser-facing URL construction without
// making any real network calls to Cloudflare — the ingestion/HTTP paths are
// covered by the live service and are intentionally not hit here.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function freshStream(env) {
  // lib/stream reads env at require time, so clear the cache and reset vars
  // between scenarios to test both the configured and unconfigured branches.
  delete require.cache[require.resolve('../lib/stream')];
  const keys = ['CF_STREAM_ACCOUNT_ID', 'CF_STREAM_API_TOKEN', 'CF_STREAM_CUSTOMER_SUBDOMAIN', 'CF_STREAM_SIGNED'];
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, env || {});
  return require('../lib/stream');
}

test('Stream is not configured when env vars are missing', () => {
  const s = freshStream({});
  assert.equal(s.isConfigured(), false);
  assert.deepEqual(s.missingVars().sort(), ['CF_STREAM_ACCOUNT_ID', 'CF_STREAM_API_TOKEN']);
  // With no config there is no customer subdomain, so URL builders return null.
  assert.equal(s.iframeUrl('abc123'), null);
  assert.equal(s.hlsUrl('abc123'), null);
});

test('placeholder values do not count as configured', () => {
  const s = freshStream({ CF_STREAM_ACCOUNT_ID: 'your-account-id', CF_STREAM_API_TOKEN: 'replace-this-token' });
  assert.equal(s.isConfigured(), false);
});

test('configured Stream builds adaptive playback URLs from the customer subdomain', () => {
  const s = freshStream({
    CF_STREAM_ACCOUNT_ID: 'acct1234567890',
    CF_STREAM_API_TOKEN: 'tok-abcdefghij1234567890',
    CF_STREAM_CUSTOMER_SUBDOMAIN: 'customer-test123'
  });
  assert.equal(s.isConfigured(), true);
  assert.deepEqual(s.missingVars(), []);

  const uid = 'vid-9f8e7d';
  assert.equal(
    s.iframeUrl(uid),
    'https://customer-test123.cloudflarestream.com/vid-9f8e7d/iframe'
  );
  assert.equal(
    s.hlsUrl(uid),
    'https://customer-test123.cloudflarestream.com/vid-9f8e7d/manifest/video.m3u8'
  );
  assert.equal(
    s.thumbnailUrl(uid),
    'https://customer-test123.cloudflarestream.com/vid-9f8e7d/thumbnails/thumbnail.jpg'
  );
});

test('iframe URL includes a startTime when a resume position is provided', () => {
  const s = freshStream({
    CF_STREAM_ACCOUNT_ID: 'acct1234567890',
    CF_STREAM_API_TOKEN: 'tok-abcdefghij1234567890',
    CF_STREAM_CUSTOMER_SUBDOMAIN: 'customer-test123'
  });
  const url = s.iframeUrl('vid1', { startTime: 42.7 });
  assert.match(url, /\?startTime=42s$/);
  // Zero / negative start times add no query string.
  assert.equal(s.iframeUrl('vid1', { startTime: 0 }), 'https://customer-test123.cloudflarestream.com/vid1/iframe');
});

test('the basic-upload size limit is exposed and matches Cloudflare (200MB)', () => {
  const s = freshStream({
    CF_STREAM_ACCOUNT_ID: 'acct1234567890',
    CF_STREAM_API_TOKEN: 'tok-abcdefghij1234567890'
  });
  assert.equal(s.uploadBasicMaxBytes(), 200 * 1024 * 1024);
});

test('uploadFromBuffer rejects empty and oversized buffers without calling the network', async () => {
  const s = freshStream({
    CF_STREAM_ACCOUNT_ID: 'acct1234567890',
    CF_STREAM_API_TOKEN: 'tok-abcdefghij1234567890'
  });
  await assert.rejects(() => s.uploadFromBuffer(Buffer.alloc(0)), /empty/i);
  const oversized = { length: s.uploadBasicMaxBytes() + 1 };
  // Fake a Buffer-like oversized object so we don't actually allocate 200MB.
  Object.setPrototypeOf(oversized, Buffer.prototype);
  await assert.rejects(() => s.uploadFromBuffer(oversized), (err) => err.code === 'STREAM_TOO_LARGE');
});

// Keep the module resolvable by path for clarity in failure output.
test('lib/stream resolves to the expected file', () => {
  assert.equal(path.basename(require.resolve('../lib/stream')), 'stream.js');
});
