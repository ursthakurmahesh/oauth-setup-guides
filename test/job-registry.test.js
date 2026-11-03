const test = require('node:test');
const assert = require('node:assert');
const { restoreJobEntry } = require('../src/agent.js');

test('boot restore marks in-flight jobs interrupted with a truthful message', () => {
  const j = restoreJobEntry({ id: 'abc123', query: 'figma.com', status: 'running', created_at: '2026-11-03T17:00:00Z' });
  assert.strictEqual(j.status, 'interrupted');
  assert.match(j.error, /restarted/i);
  assert.ok(j.log.some((l) => /interrupted/.test(l.line)));
});

test('boot restore keeps completed jobs queryable', () => {
  const j = restoreJobEntry({ id: 'def456', query: 'linear', status: 'done', slug: 'gen-linear-x', created_at: '2026-11-03T16:00:00Z' });
  assert.strictEqual(j.status, 'done');
  assert.strictEqual(j.slug, 'gen-linear-x');
  assert.strictEqual(j.error, undefined);
});

test('boot restore drops malformed entries', () => {
  assert.strictEqual(restoreJobEntry(null), null);
  assert.strictEqual(restoreJobEntry({ status: 'done' }), null);
});
