'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { validateGuide } = require('../src/guideSchema');
const { normalizeQuery, extractEvidence, onApex } = require('../src/investigate');
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

test('onApex accepts curated official docs hosts on a different apex, nothing else', () => {
  assert.equal(onApex('https://learn.microsoft.com/linkedin/marketing/', 'linkedin.com'), true);
  assert.equal(onApex('https://shopify.dev/docs/apps/auth', 'shopify.com'), true);
  assert.equal(onApex('https://developers.facebook.com/docs', 'facebook.com'), true); // same apex already
  assert.equal(onApex('https://api.slack.com/authentication', 'slack.com'), true); // same apex already
  assert.equal(onApex('https://learn.microsoft.com/anything', 'figma.com'), false);
  assert.equal(onApex('https://evil-oauth-guides.example.com', 'linkedin.com'), false);
  assert.equal(onApex('https://notlearn.microsoft.com', 'linkedin.com'), false);
});

const { estimateEffort } = require('../src/effort');

test('estimateEffort labels a rubric-based estimate, never a measurement', () => {
  const easy = estimateEffort({ difficulty: 'easy', steps: [1, 2, 3] });
  assert.match(easy.text, /10-20 minutes/);
  assert.match(easy.text, /estimate/);
  assert.match(easy.text, /estimate/);
  assert.ok(!/not measured/i.test(easy.text));
  const manySteps = estimateEffort({ difficulty: 'easy', steps: [1, 2, 3, 4, 5, 6, 7] });
  assert.match(manySteps.text, /15-30 minutes/);
  const hard = estimateEffort({ difficulty: 'hard', steps: [1, 2, 3, 4, 5, 6, 7] });
  assert.match(hard.text, /hours/);
});

test('markdown reports an effort estimate instead of "not measured"', () => {
  const g = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'guides', 'github.json'), 'utf8'));
  const md = guideToMarkdown(g);
  assert.match(md, /Expected time\/effort:\*\* roughly/);
  assert.ok(!/setup time not measured/.test(md));
  assert.match(md, /approval wait:/);
});

const { mergeResults, inferApexFromResults } = require('../src/investigate');

test('input type A: a plain brand name stays a name query (discovery resolves it)', () => {
  const q = normalizeQuery('HubSpot');
  assert.equal(q.kind, 'name');
  assert.equal(q.domain, null);
  assert.equal(q.apex, null);
});

test('input type B: a homepage URL is a domain query with apex-derived brand', () => {
  for (const raw of ['figma.com', 'https://www.figma.com', 'https://figma.com/']) {
    const q = normalizeQuery(raw);
    assert.equal(q.kind, 'domain', raw);
    assert.equal(q.apex, 'figma.com', raw);
    assert.equal(q.name, 'figma', raw);
  }
});

test('input type C: a deep docs link is fetched exactly, brand comes from the apex', () => {
  const q = normalizeQuery('https://developers.notion.com/docs/authorization');
  assert.equal(q.kind, 'docs_url');
  assert.equal(q.url, 'https://developers.notion.com/docs/authorization');
  assert.equal(q.apex, 'notion.com');
  assert.equal(q.name, 'notion'); // not "developers"
  const q2 = normalizeQuery('developer.calendly.com/api-docs/');
  assert.equal(q2.kind, 'docs_url');
  assert.equal(q2.name, 'calendly');
  assert.equal(q2.url, 'https://developer.calendly.com/api-docs/');
});

test('mergeResults dedupes across search angles, first occurrence wins', () => {
  const m = mergeResults([[{ url: 'https://a.com/1' }, { url: 'https://a.com/2' }], [{ url: 'https://a.com/1' }, { url: 'https://a.com/3' }]]);
  assert.deepEqual(m.map((r) => r.url), ['https://a.com/1', 'https://a.com/2', 'https://a.com/3']);
});

test('inferApexFromResults resolves a brand to its provider apex, conservatively', () => {
  const apex = inferApexFromResults([{ url: 'https://developer.hubspot.com/docs/api/oauth' }, { url: 'https://example.com/x' }], 'HubSpot');
  assert.equal(apex, 'hubspot.com');
  assert.equal(inferApexFromResults([{ url: 'https://unrelated-blog.com/post' }], 'HubSpot'), null);
  assert.equal(inferApexFromResults([], 'HubSpot'), null);
});

test('homepage-looking URLs (/index.html, /home, locale roots) are domain queries, not docs links', () => {
  for (const raw of ['https://www.figma.com/index.html', 'https://figma.com/home', 'https://figma.com/en/', 'linear.app']) {
    assert.equal(normalizeQuery(raw).kind, 'domain', raw);
  }
  assert.equal(normalizeQuery('https://figma.com/en/?ref=x').kind, 'docs_url');
});

test('inferApexFromResults ignores third-party publishers even when the brand is in the path', () => {
  assert.equal(inferApexFromResults([{ url: 'https://medium.com/hubspot-guide' }], 'HubSpot'), null);
  assert.equal(inferApexFromResults([{ url: 'https://medium.com/hubspot-guide' }, { url: 'https://developers.hubspot.com/docs/api/oauth' }], 'HubSpot'), 'hubspot.com');
});
