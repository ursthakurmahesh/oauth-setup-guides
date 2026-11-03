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
