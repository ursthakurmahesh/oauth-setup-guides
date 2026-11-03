'use strict';

// Citation-by-reference: the model cites a numbered passage [Pn]; the server
// substitutes the exact fetched sentence and the verbatim gate runs on that
// real evidence text. Paraphrases alone still fail; not_found stays not_found.

const test = require('node:test');
const assert = require('node:assert');
const { buildCandidate } = require('../src/agent');
const { passageIndex } = require('../src/llm');

const evidence = {
  query: { input: 'figma.com' },
  search_results: [],
  pages: [{
    url: 'https://developers.figma.com/docs/rest-api/oauth-apps/',
    title: 'OAuth Apps',
    headings: ['Create an OAuth app'],
    sentences: [
      "You'll need to register an OAuth app in order to access the REST API.",
      'Your OAuth app is created in a draft state and the configuration modal for your OAuth app appears.',
      'On the OAuth credentials page, click Add a redirect URL and enter your callback URL.',
    ],
    links: [],
  }],
};

const baseGuide = {
  app: 'Figma', website: 'https://www.figma.com', difficulty: 'easy',
  summary: 's', approval: { required: 'unknown', typical_timeline: 'x', notes: 'n' },
  steps: [], nuances: [], agent_can_do: [], human_must_do: [],
  sources: [{ title: 'OAuth Apps', url: 'https://developers.figma.com/docs/rest-api/oauth-apps/' }],
};
const job = { id: 'abcdef123456', query: 'figma.com' };

test('passage citation substitutes the exact fetched sentence and passes the gate', () => {
  const guide = { ...baseGuide, coverage: {
    create_app: { status: 'covered', passage: 'P1', quote: 'You need to register an OAuth app to use the REST API', url: 'https://developers.figma.com/docs/rest-api/oauth-apps/' },
    credentials: { status: 'covered', passage: 'P2', quote: 'paraphrased credentials text', url: 'https://developers.figma.com/docs/rest-api/oauth-apps/' },
    redirect_uri: { status: 'covered', passage: 'P3', quote: 'paraphrased redirect text', url: 'https://developers.figma.com/docs/rest-api/oauth-apps/' },
    scopes: { status: 'not_found' }, approval: { status: 'not_found' }, agent_human: { status: 'not_found' },
  } };
  const { coverage, missingSlots } = buildCandidate(job, evidence, guide);
  assert.strictEqual(coverage.create_app.status, 'verified');
  assert.strictEqual(coverage.create_app.quote, "You'll need to register an OAuth app in order to access the REST API.");
  assert.strictEqual(coverage.credentials.status, 'verified');
  assert.strictEqual(coverage.redirect_uri.status, 'verified');
  assert.deepStrictEqual(missingSlots, []);
});

test('a passage id never resurrects a slot the model marked not_found', () => {
  const guide = { ...baseGuide, coverage: {
    create_app: { status: 'not_found', passage: 'P1', quote: '', url: '' },
    credentials: { status: 'not_found' }, redirect_uri: { status: 'not_found' },
    scopes: { status: 'not_found' }, approval: { status: 'not_found' }, agent_human: { status: 'not_found' },
  } };
  const { coverage } = buildCandidate(job, evidence, guide);
  assert.strictEqual(coverage.create_app.status, 'not_found');
});

test('paraphrased quote with no passage citation still fails the gate', () => {
  const guide = { ...baseGuide, coverage: {
    create_app: { status: 'covered', quote: 'You need to register an OAuth app to use the REST API', url: 'https://developers.figma.com/docs/rest-api/oauth-apps/' },
    credentials: { status: 'not_found' }, redirect_uri: { status: 'not_found' },
    scopes: { status: 'not_found' }, approval: { status: 'not_found' }, agent_human: { status: 'not_found' },
  } };
  const { coverage } = buildCandidate(job, evidence, guide);
  assert.strictEqual(coverage.create_app.status, 'not_found');
});

test('passageIndex ids are stable and per page order', () => {
  const refs = passageIndex(evidence);
  assert.deepStrictEqual(refs.map((r) => r.id), ['P1', 'P2', 'P3']);
  assert.strictEqual(refs[0].url, 'https://developers.figma.com/docs/rest-api/oauth-apps/');
});
