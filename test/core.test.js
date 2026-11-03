'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { validateGuide } = require('../src/guideSchema');
const { normalizeQuery, extractEvidence } = require('../src/investigate');
const { detectBackend, buildUserPrompt } = require('../src/llm');
const { guideToMarkdown } = require('../src/markdown');
const { listGuides, getGuide, searchGuides } = require('../src/store');

test('normalizeQuery parses domains, urls and names', () => {
  assert.deepEqual(normalizeQuery('figma.com').domain, 'figma.com');
  assert.deepEqual(normalizeQuery('https://www.figma.com/x').domain, 'figma.com');
  assert.deepEqual(normalizeQuery('Linear').kind, 'name');
  assert.throws(() => normalizeQuery('   '));
});

test('extractEvidence pulls oauth-related sentences', () => {
  const html = `<html><head><title>Acme Dev</title></head><body>
    <h2>Create an OAuth app</h2>
    <p>To create an OAuth app, open the developer console and register your redirect URL with the provider.</p>
    <p>Our pricing plans start at ten dollars.</p></body></html>`;
  const ev = extractEvidence(html);
  assert.equal(ev.title, 'Acme Dev');
  assert.ok(ev.headings.some((h) => /OAuth app/.test(h)));
  assert.ok(ev.sentences.some((s) => /register your redirect URL/.test(s)));
  assert.ok(!ev.sentences.some((s) => /pricing plans/.test(s)));
});

test('every library guide validates against the schema', () => {
  const dir = path.join(__dirname, '..', 'data', 'guides');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 5, 'expected at least 5 library guides');
  for (const f of files) {
    const g = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.deepEqual(validateGuide(g), [], `${f} failed validation`);
  }
});

test('validateGuide rejects guides without sources or steps', () => {
  const bad = { slug: 'x', app: 'X', summary: 's', last_checked: '2026-01-01' };
  const errors = validateGuide(bad);
  assert.ok(errors.some((e) => /sources/.test(e)));
  assert.ok(errors.some((e) => /steps/.test(e)));
});

test('store search finds guides by app name', () => {
  assert.ok(listGuides().length >= 5);
  assert.ok(getGuide('github'));
  assert.ok(searchGuides('spotify').some((g) => g.slug === 'spotify'));
  assert.equal(searchGuides('zzz-no-match').length, 0);
});

test('detectBackend prefers gemini, then ollama, then openai-compatible', () => {
  assert.equal(detectBackend({}), null);
  assert.equal(detectBackend({ GEMINI_API_KEY: 'k', OPENAI_API_KEY: 'k' }).kind, 'gemini');
  assert.equal(detectBackend({ USE_OLLAMA: '1', OPENAI_API_KEY: 'k' }).kind, 'ollama');
  assert.equal(detectBackend({ OPENAI_API_KEY: 'k' }).kind, 'openai');
});

test('buildUserPrompt carries fetched evidence', () => {
  const prompt = buildUserPrompt({
    query: { input: 'example.com', kind: 'domain' },
    pages: [{ url: 'https://example.com/dev', title: 'Dev', headings: ['OAuth'], sentences: ['Register your OAuth app in the console first.'] }],
    search_results: [],
  });
  assert.match(prompt, /example\.com\/dev/);
  assert.match(prompt, /Register your OAuth app/);
});

test('guideToMarkdown includes verification badges and sources', () => {
  const g = getGuide('github');
  const md = guideToMarkdown(g);
  assert.match(md, /# OAuth setup guide: GitHub/);
  assert.match(md, /source page fetched by server/);
  assert.match(md, /docs\.github\.com/);
});

test('approval.required "unknown" is valid and renders honestly', () => {
  const { validateGuide } = require('../src/guideSchema');
  const { guideToMarkdown } = require('../src/markdown');
  const base = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'generated', 'gen-linear-fe1882.json'), 'utf8'));
  assert.equal(base.approval.required, 'unknown');
  assert.deepEqual(validateGuide(base), []);
  const md = guideToMarkdown(base);
  assert.match(md, /unknown - not stated in the fetched sources/);
  assert.doesNotMatch(md, /No approval required to start/);
});

test('generated approval badge never claims "no approval" without source support', () => {
  const { renderGuidePage } = require('../server');
  const { getGuide } = require('../src/store');
  const g = getGuide('gen-linear-fe1882');
  const html = renderGuidePage(g);
  assert.match(html, /unknown - not stated in the fetched sources/);
  assert.doesNotMatch(html, /not required to start[^<]*unknown/);
});

test('strongPassageCount counts only OAuth-mechanics sentences', () => {
  const { strongPassageCount } = require('../src/investigate');
  const pages = [{ sentences: ['Create an OAuth app and copy the client secret.', 'Our pricing is simple and fair for teams of all sizes.'] }];
  assert.equal(strongPassageCount(pages), 1);
});
