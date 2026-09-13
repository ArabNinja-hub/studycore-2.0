'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

function freshStream(env) {
  delete require.cache[require.resolve('../lib/stream')];
  for (const key of ['BUNNY_LIBRARY_ID', 'BUNNY_API_KEY', 'BUNNY_CDN_HOSTNAME']) delete process.env[key];
  Object.assign(process.env, env || {});
  return require('../lib/stream');
}
const config = { BUNNY_LIBRARY_ID: '12345', BUNNY_API_KEY: 'server-secret-test-key', BUNNY_CDN_HOSTNAME: 'video.example.b-cdn.net' };

test('Bunny Stream requires all three server environment variables', () => {
  let stream = freshStream({});
  assert.equal(stream.isConfigured(), false);
  assert.deepEqual(stream.missingVars(), ['BUNNY_LIBRARY_ID', 'BUNNY_API_KEY', 'BUNNY_CDN_HOSTNAME']);
  stream = freshStream(config);
  assert.equal(stream.isConfigured(), true);
  assert.deepEqual(stream.missingVars(), []);
});

test('Bunny playback assets use the configured CDN hostname', () => {
  const stream = freshStream(config);
  assert.equal(stream.hlsUrl('video-guid'), 'https://video.example.b-cdn.net/video-guid/playlist.m3u8');
  assert.equal(stream.thumbnailUrl('video-guid'), 'https://video.example.b-cdn.net/video-guid/thumbnail.jpg');
  assert.match(stream.iframeUrl('video-guid'), /^https:\/\/iframe\.mediadelivery\.net\/embed\/12345\/video-guid\?/);
});

test('upload creates a Bunny video then uploads bytes with AccessKey server-side', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'POST') return new Response(JSON.stringify({ guid: 'bunny-guid', status: 0 }), { status: 200 });
    return new Response(null, { status: 204 });
  };
  try {
    const stream = freshStream(config);
    const result = await stream.uploadFromBuffer(Buffer.from('video'), { name: 'Lesson', contentType: 'video/mp4' });
    assert.equal(result.uid, 'bunny-guid');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.headers.AccessKey, config.BUNNY_API_KEY);
    assert.equal(calls[1].options.headers.AccessKey, config.BUNNY_API_KEY);
    assert.doesNotMatch(JSON.stringify(result), /server-secret-test-key/);
  } finally { global.fetch = originalFetch; }
});

test('upload rejects empty and oversized buffers without network access', async () => {
  const stream = freshStream(config);
  await assert.rejects(() => stream.uploadFromBuffer(Buffer.alloc(0)), /empty/i);
  const oversized = { length: stream.uploadBasicMaxBytes() + 1 };
  Object.setPrototypeOf(oversized, Buffer.prototype);
  await assert.rejects(() => stream.uploadFromBuffer(oversized), (err) => err.code === 'STREAM_TOO_LARGE');
});
