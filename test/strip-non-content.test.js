const test = require('node:test');
const assert = require('node:assert');
const { stripNonContent, extractEvidence } = require('../src/investigate.js');

test('stripNonContent removes inline assets so real content survives the body cap', () => {
  const junk = 'x'.repeat(500000);
  const html = `<html><head><title>Pinterest-style docs</title><style>${junk}</style></head>` +
    `<body><script>${junk}</script><article><p>The redirect_uri used during OAuth authorization ` +
    `must exactly match a redirect URI registered in your app profile, otherwise the ` +
    `authorization request is rejected by the consent server.</p></article></body></html>`;
  const stripped = stripNonContent(html);
  assert.ok(stripped.length < 1000, `expected small stripped page, got ${stripped.length}`);
  const facts = extractEvidence(stripped.slice(0, 100000));
  assert.ok(facts.sentences.some((s) => /redirect_uri/.test(s)), 'OAuth passage must survive stripping + cap');
});

test('stripNonContent keeps visible article text and drops script/style/svg/template/noscript/comments', () => {
  const html = '<!-- c --><style>.a{color:red}</style><script>var t="oauth fake";</script>' +
    '<svg><text>icon</text></svg><noscript>enable js</noscript><template>hidden</template>' +
    '<p>Register your OAuth app in the developer console to receive a client id and client secret.</p>';
  const out = stripNonContent(html);
  assert.ok(out.includes('Register your OAuth app'));
  assert.ok(!out.includes('oauth fake'));
  assert.ok(!out.includes('color:red'));
  assert.ok(!out.includes('enable js'));
  assert.ok(!out.includes('hidden'));
});

test('stripHtml decodes hex and numeric entities so verbatim quotes match', () => {
  const { stripHtml } = require('../src/investigate.js');
  assert.strictEqual(stripHtml('<p>Configure your app&#x27;s redirect URI for OAuth</p>').trim(),
    "Configure your app's redirect URI for OAuth");
  assert.strictEqual(stripHtml('<p>Register the app&#39;s client secret</p>').trim(),
    "Register the app's client secret");
});

test('verbatim gate normalization: real entity-mangled quote matches, invented quote does not', () => {
  const { stripHtml } = require('../src/investigate.js');
  const norm = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim();
  const pageText = norm(stripHtml('<p>The value given for redirect_uri during OAuth authorization will be matched against the redirect URIs listed in your app&#x27;s profile.</p>'));
  const realQuote = norm("The value given for redirect_uri during OAuth authorization will be matched against the redirect URIs listed in your app's profile.");
  const inventedQuote = norm('Pinterest requires manual approval before any OAuth app can go live in production.');
  assert.ok(pageText.includes(realQuote), 'real quote with entities must match');
  assert.ok(!pageText.includes(inventedQuote), 'invented quote must NOT match');
});
