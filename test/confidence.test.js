'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { buildConfidence, buildStepConfidence } = require('../src/confidence');
const { guideToMarkdown } = require('../src/markdown');

const guide = require('../data/guides/github.json');

test('walkthrough-scoped evidence marks registration and credential issuance as tested, but keeps other sections docs-backed at best', () => {
  const conf = buildConfidence(guide, { tested_at: '2026-11-03', tested_scope: ['app_registration', 'credential_issuance'] });
  assert.strictEqual(conf.registration.status, 'tested');
  assert.strictEqual(conf.credentials.status, 'tested');
  assert.notStrictEqual(conf.scopes.status, 'tested');
  assert.strictEqual(conf.timeline.status, 'uncertain', 'approval wait times are never claimed as tested');
});

test('without walkthrough evidence, registration falls back to docs or uncertain and never claims testing', () => {
  const conf = buildConfidence(guide, null);
  assert.notStrictEqual(conf.registration.status, 'tested');
  assert.ok(['docs', 'uncertain'].includes(conf.registration.status));
  const bare = buildConfidence({ steps: [], sources: [] }, null);
  assert.strictEqual(bare.registration.status, 'uncertain');
  assert.strictEqual(bare.credentials.status, 'uncertain');
});

test('step confidence: verified/sourced steps are docs-backed, unsourced steps are uncertain', () => {
  assert.strictEqual(buildStepConfidence({ verified: true, source: 'https://x' }, []).status, 'docs');
  assert.strictEqual(buildStepConfidence({ verified: false }, []).status, 'uncertain');
});

test('markdown export carries the three-tier badges and keeps the effort estimate', () => {
  const md = guideToMarkdown(guide, { tested_at: '2026-11-03', tested_scope: ['app_registration', 'credential_issuance'], note: 'x' });
  assert.match(md, /registration \[Verified by Testing\]/);
  assert.match(md, /approval wait time \[Uncertain \/ Unverified\]/);
  assert.match(md, /Expected time\/effort:\*\* roughly/);
  const mdBare = guideToMarkdown(guide, null);
  assert.doesNotMatch(mdBare, /Verified by Testing/);
});

test('walkthrough records attach by provider apex, never by display name', () => {
  delete require.cache[require.resolve('../server.js')];
  const { renderGuidePage } = require('../server.js');
  const fakeLinear = JSON.parse(JSON.stringify(guide));
  fakeLinear.slug = 'gen-linear-x1';
  fakeLinear.app = 'Linear';
  fakeLinear.website = 'https://linear.app';
  fakeLinear.sources = [{ url: 'https://linear.app/docs', title: 'docs' }];
  const html = renderGuidePage(fakeLinear);
  assert.match(html, /Verified by Testing/, 'linear walkthrough attaches via apex');
  const fakeOther = JSON.parse(JSON.stringify(guide));
  fakeOther.slug = 'gen-other-x1';
  fakeOther.website = 'https://example.com';
  fakeOther.console_url = null;
  fakeOther.sources = [{ url: 'https://example.com/docs', title: 'docs' }];
  const html2 = renderGuidePage(fakeOther);
  assert.doesNotMatch(html2, /Verified by Testing/, 'no apex match, no tested badge');
});

test('probeBrandApex guard rails: URLs, dots and short slugs never probe the network', async () => {
  const { probeBrandApex } = require('../src/investigate');
  assert.strictEqual(await probeBrandApex('linear.app'), null);
  assert.strictEqual(await probeBrandApex('https://linear.app'), null);
  assert.strictEqual(await probeBrandApex('ab'), null);
  assert.strictEqual(await probeBrandApex(''), null);
});
