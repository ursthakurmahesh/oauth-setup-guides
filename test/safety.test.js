'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isBlockedUrl, normalizeQuery } = require('../src/investigate');
const { validateGuide } = require('../src/guideSchema');
const { startGeneration, getJob } = require('../src/agent');
const { server } = require('../server');

test('SSRF guard blocks internal and non-http targets', () => {
  for (const u of [
    'http://127.0.0.1/admin', 'http://localhost:3000/', 'http://10.0.0.4/x',
    'http://192.168.1.1/', 'http://172.16.0.1/', 'http://169.254.169.254/latest/meta-data',
    'file:///etc/passwd', 'ftp://example.com/x', 'not a url',
  ]) assert.equal(isBlockedUrl(u), true, u);
  for (const u of ['https://linear.app/developers', 'http://docs.example.com/x'])
    assert.equal(isBlockedUrl(u), false, u);
});

test('generate rejects an empty query', () => {
  assert.throws(() => startGeneration('   '), /query is required/);
});

test('model-shaped but invalid output fails schema validation, never ships', () => {
  const hallucinated = {
    app: 'FakeApp', summary: 'x',
    approval: { required: 'maybe' },
    steps: [{ title: 'Do thing' }],
    sources: [{ title: 'no url' }],
  };
  const errors = validateGuide(hallucinated);
  assert.ok(errors.length >= 3, JSON.stringify(errors));
  assert.ok(errors.some((e) => /sources\[0\]/.test(e)));
  assert.ok(errors.some((e) => /verified must be a boolean/.test(e)));
});

test('http API: 400 on bad body, 404 on unknown guide/job', async () => {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  let res = await fetch(`${base}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"query":""}' });
  assert.equal(res.status, 400);
  res = await fetch(`${base}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' });
  assert.equal(res.status, 400);
  res = await fetch(`${base}/api/guides/nope-not-here`);
  assert.equal(res.status, 404);
  res = await fetch(`${base}/api/jobs/000000000000`);
  assert.equal(res.status, 404);
  res = await fetch(`${base}/api/status`);
  assert.equal(res.status, 200);
  await new Promise((r) => server.close(r));
});

test('normalizeQuery never throws on hostile input', () => {
  for (const q of ['http://', 'a'.repeat(5000), '..\\..\\etc', '<script>']) {
    try { normalizeQuery(q); } catch (e) { assert.match(e.message, /empty query|^$/); }
  }
});
