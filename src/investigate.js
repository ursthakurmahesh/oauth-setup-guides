'use strict';

// Investigation layer: given an app name or website, find the provider's real
// developer/OAuth documentation and pull the evidence a guide can be built on.
// No API keys required: resolution uses DuckDuckGo's public HTML endpoint and
// direct fetches of the provider's own pages.

const USER_AGENT = 'oauth-setup-guides/1.0 (+https://github.com) node-fetch';
const FETCH_TIMEOUT_MS = 15000;
const MAX_PAGE_BYTES = 400000;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label}`)), ms)),
  ]);
}

function isUrlLike(input) {
  return /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(input.trim());
}

function normalizeQuery(raw) {
  const input = String(raw || '').trim();
  if (!input) throw new Error('empty query');
  if (isUrlLike(input)) {
    const withProto = /^https?:\/\//.test(input) ? input : `https://${input}`;
    const host = new URL(withProto).hostname.replace(/^www\./, '');
    return { kind: 'domain', domain: host, name: host.split('.')[0], input };
  }
  return { kind: 'name', domain: null, name: input, input };
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ');
}

// SSRF guard: only public http(s) pages may be fetched.
const dns = require('dns').promises;

function ipv4Private(a, b) {
  return a === 0 || a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 169 && b === 254)
    || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19))
    || (a === 192 && b === 0) || a >= 224;
}

function isBlockedIp(ip) {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) return ipv4Private(Number(v4[1]), Number(v4[2]));
  const v6 = ip.toLowerCase();
  if (v6 === '::1' || v6 === '::' || v6.startsWith('fe80') || v6.startsWith('fc') || v6.startsWith('fd')) return true;
  const mapped = v6.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isBlockedIp(mapped[1]);
  return false;
}

function isBlockedHost(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host.includes('.') || host === 'localhost' || host.endsWith('.localhost')
    || host.endsWith('.internal') || host.endsWith('.local') || host.endsWith('.lan')) return true;
  return isBlockedIp(host);
}

function isBlockedUrl(url) {
  let u;
  try { u = new URL(url); } catch { return true; }
  if (!/^https?:$/.test(u.protocol)) return true;
  return isBlockedHost(u.hostname);
}

// Resolve DNS and refuse if every route leads to a private address.
async function resolvesPrivate(hostname) {
  if (isBlockedIp(hostname)) return true; // literal IP already checked
  try {
    const addrs = await dns.lookup(hostname, { all: true });
    return addrs.some((a) => isBlockedIp(a.address));
  } catch {
    return false; // resolution failure is handled by the fetch itself
  }
}

const MAX_BODY_CHARS = 100000; // also bounds the regex work in extraction

async function readCapped(res, cap) {
  if (!res.body) return (await res.text()).slice(0, cap);
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      chunks.push(value);
      if (size >= cap) break;
    }
  } finally {
    try { await reader.cancel(); } catch { /* socket closes */ }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8').slice(0, cap);
}

// Manual redirect handling: every hop is re-checked against the SSRF guard.
async function fetchPage(url, opts = {}) {
  if (isBlockedUrl(url)) throw new Error(`blocked by SSRF guard: ${url}`);
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const host = new URL(current).hostname;
    if (await resolvesPrivate(host)) throw new Error(`blocked: ${host} resolves to a private address`);
    const res = await fetch(current, {
      headers: { 'user-agent': USER_AGENT, accept: opts.anyText ? 'text/plain,application/xml,text/xml,*/*' : 'text/html,application/xhtml+xml' },
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error(`redirect without location from ${current}`);
      const next = new URL(loc, current).toString();
      if (isBlockedUrl(next)) throw new Error(`blocked redirect to ${next}`);
      current = next;
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${current}`);
    const type = res.headers.get('content-type') || '';
    if (!opts.anyText && !type.includes('html')) throw new Error(`not html (${type}) for ${current}`);
    if (opts.anyText && /^(image|video|audio|application\/(octet|pdf|zip))/.test(type)) throw new Error(`binary (${type}) for ${current}`);
    const text = await readCapped(res, opts.cap || MAX_BODY_CHARS);
    return { html: text, finalUrl: current };
  }
  throw new Error(`too many redirects from ${url}`);
}

// Find developer-documentation links for an app. Engine chain with honest
// degradation: DuckDuckGo HTML (bot-screened from some networks), then Bing
// (decoding its /ck/a redirect links). Returns [] if every engine is
// unreachable - callers fall back to direct first-party URL discovery.
function unwrapDuckDuckGo(href) {
  try {
    const u = new URL(href, 'https://html.duckduckgo.com');
    const inner = u.searchParams.get('uddg');
    if (inner) return inner;
  } catch { /* keep href */ }
  return href;
}

function unwrapBing(href) {
  try {
    const u = new URL(href.replace(/&amp;/g, '&'));
    const enc = u.searchParams.get('u');
    if (enc && enc.startsWith('a1')) {
      return Buffer.from(enc.slice(2), 'base64url').toString('utf8');
    }
  } catch { /* keep href */ }
  return href;
}

function skipLink(href) {
  let host;
  try { host = new URL(href).hostname.toLowerCase(); } catch { return true; }
  const blockedHosts = ['duckduckgo.com', 'html.duckduckgo.com', 'youtube.com', 'www.youtube.com',
    'facebook.com', 'www.facebook.com', 'bing.com', 'www.bing.com',
    'merriam-webster.com', 'www.merriam-webster.com', 'dictionary.cambridge.org'];
  if (blockedHosts.includes(host)) return true;
  return host.endsWith('.wikipedia.org');
}

async function searchDuckDuckGo(terms) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(terms)}`;
  const { html } = await fetchPage(url);
  const links = [];
  const re = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && links.length < 8) {
    const href = unwrapDuckDuckGo(m[1]);
    if (!/^https?:\/\//.test(href) || skipLink(href)) continue;
    links.push({ url: href, title: stripHtml(m[2]).trim().slice(0, 160) });
  }
  if (!links.length) throw new Error('duckduckgo returned no parseable results (possibly bot-screened)');
  return links;
}

async function searchBing(terms) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(terms)}&count=15`;
  const res = await withTimeout(fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', accept: 'text/html' },
    redirect: 'follow',
  }), FETCH_TIMEOUT_MS, url);
  if (!res.ok) throw new Error(`bing HTTP ${res.status}`);
  const html = await res.text();
  const links = [];
  const re = /<a[^>]+href="(https?:\/\/www\.bing\.com\/ck\/a\?[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && links.length < 10) {
    const href = unwrapBing(m[1]);
    if (!/^https?:\/\//.test(href) || skipLink(href)) continue;
    if (links.some((l) => l.url === href)) continue;
    links.push({ url: href, title: stripHtml(m[2]).trim().slice(0, 160) });
  }
  if (!links.length) throw new Error('bing returned no parseable results');
  return links;
}

async function searchDeveloperDocs(name, domain) {
  const terms = domain
    ? `${domain} oauth app developer documentation`
    : `${name} oauth app developer documentation`;
  try {
    return await searchDuckDuckGo(terms);
  } catch { /* fall through to bing */ }
  return searchBing(terms);
}

// Pull first-party developer/docs links out of a provider's own homepage.
function extractDeveloperLinks(html, baseUrl) {
  const out = [];
  const re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 40) {
    const label = stripHtml(m[2]).toLowerCase();
    const href = m[1].toLowerCase();
    if (!/developer|docs|api|oauth/.test(label) && !/developer|docs\.|\/docs|api\./.test(href)) continue;
    try {
      const abs = new URL(m[1], baseUrl).toString();
      if (!out.some((o) => o.url === abs)) out.push({ url: abs, title: stripHtml(m[2]).trim().slice(0, 120) });
    } catch { /* bad link */ }
  }
  return out;
}

// Sentences from a page that are likely to carry OAuth-setup facts.
function extractEvidence(html) {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [null, ''])[1];
  const headings = [];
  const hRe = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi;
  let m;
  while ((m = hRe.exec(html)) && headings.length < 25) {
    const h = stripHtml(m[1]).trim();
    if (h) headings.push(h.slice(0, 140));
  }
  const text = stripHtml(html);
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 40 && s.length < 500)
    .filter((s) => /oauth|client id|client secret|redirect|callback|consent|scope|verif|review|approv|app registr|developer (account|portal|dashboard)|create (an )?app/i.test(s))
    .slice(0, 60);
  const links = [];
  for (const m2 of html.matchAll(/(?:href="|\]\()(\/[^"')\s]+|https?:\/\/[^"')\s]+)/g)) { if (links.length < 120 && !links.includes(m2[1])) links.push(m2[1]); }
  return { title: stripHtml(title).trim().slice(0, 160), headings, sentences, links };
}

// Candidate first-party URLs worth trying even without search results.
function candidateUrls(query) {
  const urls = [];
  if (query.domain) {
    const d = query.domain;
    const parts = d.split('.');
    const twoLevel = new Set(['co.uk', 'org.uk', 'com.au', 'co.in', 'co.jp', 'com.br', 'co.nz', 'com.sg']);
    const last2 = parts.slice(-2).join('.');
    const apex = twoLevel.has(last2) && parts.length >= 3 ? parts.slice(-3).join('.') : last2;
    urls.push(
      `https://developer.${apex}`,
      `https://developers.${apex}`,
      `https://docs.${apex}`,
      `https://${d}`,
    );
  }
  return urls;
}

// Rank and bound evidence candidates. For a domain query, only that domain
// (and its subdomains) counts as first-party evidence - search junk from
// unrelated domains must not be fetched or cited.
function apexOf(hostname) {
  const parts = String(hostname || '').toLowerCase().replace(/^www\./, '').split('.');
  const twoLevel = new Set(['co.uk', 'org.uk', 'com.au', 'co.in', 'co.jp', 'com.br', 'co.nz', 'com.sg']);
  const last2 = parts.slice(-2).join('.');
  return twoLevel.has(last2) && parts.length >= 3 ? parts.slice(-3).join('.') : last2;
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

// Official developer/docs hosts that live on a DIFFERENT apex than the
// provider's own domain. Curated by hand: only hosts the provider itself
// operates for its developer documentation. This is not an open door for
// third-party evidence - any host not listed here still must be on-apex.
const OFFICIAL_DOC_HOSTS = {
  'linkedin.com': ['learn.microsoft.com'],
  'shopify.com': ['shopify.dev'],
  'notion.so': ['notion.com'],
  'twitter.com': ['x.com', 'developer.twitter.com'],
  'x.com': ['twitter.com', 'developer.x.com'],
};

function onApex(url, apex) {
  const h = hostOf(url).replace(/^www\./, '');
  if (h === apex || h.endsWith(`.${apex}`)) return true;
  return (OFFICIAL_DOC_HOSTS[apex] || []).some((m) => h === m || h.endsWith(`.${m}`));
}

function docScore(url, query) {
  const h = hostOf(url);
  const p = (() => { try { return new URL(url).pathname.toLowerCase(); } catch { return ''; } })();
  let score = 0;
  const apex = query.domain ? apexOf(query.domain) : null;
  if (apex && onApex(url, apex)) score += 4;
  const name = String(query.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (name && h.replace(/[^a-z0-9]/g, '').includes(name)) score += 3;
  if (/oauth|auth|api|develop|docs?|app/.test(p)) score += 2;
  if (/^(developer|developers|docs|api)\./.test(h.replace(/^www\./, ''))) score += 1;
  if (/blog|careers|pricing|about|press|news/.test(p)) score -= 2;
  if (p === '/' || /^\/[a-z]{2}(-[a-z]+)?\/?$/.test(p)) score -= 1; // bare locale roots
  return score;
}

// Strong evidence = sentences about the actual OAuth app mechanics, not just
// any page that mentions "api" or "developer".
const STRONG_RE = /oauth|client[ _-]?(id|secret)|redirect[ _-]?(uri|url)|authori[sz]ation (code|url|endpoint|server)|access token|callback url|register (an |your )?(app|application)|create (an |your |a new )?(oauth )?(app|application|integration)/i;
const MIN_STRONG_PASSAGES = 6;
const OAUTH_PATHS = ['/docs/oauth', '/oauth', '/docs/authentication', '/docs/authorization', '/docs/api/authentication',
  '/docs/oauth2', '/docs/oauth-2-0', '/docs/auth', '/developers/oauth', '/developers/docs/oauth', '/docs/guides/authentication',
  '/docs/api-reference/authentication', '/docs/rest/authentication', '/api/oauth', '/docs/getting-started/authentication'];
function strongSentences(sentences) { return (sentences || []).filter((x) => STRONG_RE.test(x)); }
function strongPassageCount(pages) { return pages.reduce((n, pg) => n + strongSentences(pg.sentences).length, 0); }

async function investigate(rawQuery, log, partialOut) {
  const say = log || (() => {});
  const query = normalizeQuery(rawQuery);
  say(`Resolving "${query.input}" (${query.kind})`);
  const evidence = { query, search_results: [], pages: [] };
  if (partialOut) { partialOut.query = query; partialOut.pages = evidence.pages; partialOut.search_results = evidence.search_results; }

  try {
    evidence.search_results = await searchDeveloperDocs(query.name, query.domain);
    say(`Search returned ${evidence.search_results.length} candidate doc links`);
  } catch (err) {
    say(`Search failed (${err.message}); falling back to direct URLs`);
  }

  // Rank search candidates; for a domain query keep only first-party hosts.
  const apex = query.domain ? apexOf(query.domain) : null;
  let ranked = evidence.search_results
    .map((r) => ({ url: r.url, score: docScore(r.url, query) }))
    .sort((a, b) => b.score - a.score);
  if (apex) {
    const firstParty = ranked.filter((r) => onApex(r.url, apex));
    const dropped = ranked.length - firstParty.length;
    if (dropped) say(`Dropped ${dropped} off-domain search result(s); only ${apex} counts as evidence for a domain query`);
    ranked = firstParty;
  }
  const targets = [];
  for (const r of ranked.slice(0, 4)) targets.push(r.url);
  for (const u of candidateUrls(query)) if (!targets.includes(u)) targets.push(u);
  const extraTargets = [];
  const finalTargets = targets.slice(0, 6);

  for (const url of finalTargets) {
    try {
      say(`Fetching ${url}`);
      const { html, finalUrl } = await fetchPage(url);
      const facts = extractEvidence(html);
      evidence.pages.push({ url: finalUrl, requestedUrl: url, ...facts });
      say(`Extracted ${facts.sentences.length} OAuth-related passages from ${url}`);
      for (const link of extractDeveloperLinks(html, url).slice(0, 3)) {
        if (apex && !onApex(link.url, apex)) continue;
        if (!/oauth|auth|api|app|develop|doc/i.test(link.url)) continue;
        if (!targets.includes(link.url) && !extraTargets.includes(link.url)) {
          extraTargets.push(link.url);
        }
      }
    } catch (err) {
      say(`Skipped ${url}: ${err.message}`);
    }
  }
  for (const url of extraTargets.slice(0, 2)) {
    try {
      say(`Following discovered developer link ${url}`);
      const { html, finalUrl } = await fetchPage(url);
      const facts = extractEvidence(html);
      evidence.pages.push({ url: finalUrl, requestedUrl: url, ...facts });
      say(`Extracted ${facts.sentences.length} OAuth-related passages from ${url}`);
    } catch (err) {
      say(`Skipped ${url}: ${err.message}`);
    }
  }

  // Second pass when first-party evidence is still thin: probe well-known
  // OAuth/auth doc paths on first-party hosts, then try a site-scoped search.
  // Everything stays on the queried provider's own domain; nothing is invented.
  if (apex && strongPassageCount(evidence.pages) < MIN_STRONG_PASSAGES) {
    say('First-party evidence is thin; probing well-known OAuth documentation paths');
    const hosts = new Set();
    for (const pg of evidence.pages) { const h = hostOf(pg.url); if (h && onApex(pg.url, apex)) hosts.add(h); }
    for (const u of candidateUrls(query)) { const h = hostOf(u); if (h) hosts.add(h); }
    const seen = new Set(evidence.pages.map((pg) => pg.url));
    const probes = [];
    for (const h of hosts) for (const path of OAUTH_PATHS) probes.push(`https://${h}${path}`);
    const found = [];
    // Provider-published indexes (llms.txt / sitemap.xml) list real doc URLs.
    const indexUrls = [];
    for (const h of hosts) {
      indexUrls.push(`https://${h}/llms.txt`, `https://${h}/sitemap.xml`);
      const seg = (() => { try { return new URL(evidence.pages.find((pg) => hostOf(pg.url) === h)?.url || `https://${h}/`).pathname.split('/')[1]; } catch { return ''; } })();
      if (seg) indexUrls.push(`https://${h}/${seg}/llms.txt`);
    }
    const idxResults = await Promise.allSettled([...new Set(indexUrls)].slice(0, 16).map((u) => fetchPage(u, { anyText: true, cap: 2000000 })));
    const cands = new Map();
    for (const r of idxResults) {
      if (r.status !== 'fulfilled') continue;
      for (const line of r.value.html.split(/\n|<loc>/)) {
       const lineHit = /oauth|sign in with|authori[sz]/i.test(line);
       for (const m of line.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) {
        const u = m[0].replace(/[.,;]+$/, '');
        if (!onApex(u, apex) || !(lineHit || /oauth|authenticat|authori[sz]|sign-in-with|login-with/i.test(u))) continue;
        if (/\.(png|jpe?g|svg|gif|webp|xml|json)$/i.test(u) || /\/(blog|changelog|pricing|careers)\b/.test(u)) continue;
        const score = (/oauth/i.test(u) ? 3 : 0) + (/authori[sz]|sign-in-with|login-with/i.test(u) ? 2 : 0) + (/authenticat/i.test(u) ? 1 : 0) - u.length / 200;
        if (!cands.has(u) || cands.get(u) < score + (lineHit ? 2 : 0)) cands.set(u, score + (lineHit ? 2 : 0));
       }
      }
    }
    const idxTargets = [...cands.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map((e) => e[0]);
    if (idxTargets.length) say(`Provider doc index lists ${cands.size} auth-related pages; fetching the top ${idxTargets.length}`);
    const idxSet = new Set(idxTargets);
    for (const u of idxTargets) probes.unshift(u);
    const nm = String(query.name).toLowerCase();
    for (const h of hosts) for (const sp of [`/docs/sign-in-with-${nm}`, `/docs/sign-in-with-${nm}/getting-started`, `/docs/sign-in-with-${nm}/authorization-code`]) probes.push(`https://${h}${sp}`);
    // Markdown twins of doc pages are served by many docs sites and avoid the
    // page-size cap on heavy HTML; treat them as first-party text too.
    for (const u of [...probes]) { if (!/\.md$/.test(u)) { probes.push(`${u}.md`); } }
    for (const u of probes) if (/\.md$/.test(u)) idxSet.add(u);
    const results = await Promise.allSettled(probes.slice(0, 90).map(async (url) => {
      const { html, finalUrl } = await fetchPage(url, idxSet.has(url) ? { anyText: true } : {});
      return { url, html, finalUrl };
    }));
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const { url, html, finalUrl } = r.value;
      if (seen.has(finalUrl) || !onApex(finalUrl, apex)) continue;
      const facts = extractEvidence(html);
      if (strongSentences(facts.sentences).length < 3) continue;
      seen.add(finalUrl);
      found.push({ url: finalUrl, requestedUrl: url, ...facts });
    }
    found.sort((a, b) => strongSentences(b.sentences).length - strongSentences(a.sentences).length);
    for (const f of found.slice(0, 4)) {
      evidence.pages.push(f);
      say(`Found OAuth documentation at ${f.url} (${strongSentences(f.sentences).length} relevant passages)`);
    }
    // Follow-through: OAuth reference pages usually link to the page that says
    // how to CREATE the app (dashboard/manage/register/getting-started).
    // Collect same-provider links from the best found pages and fetch them.
    {
      const follow = new Map();
      for (const f of evidence.pages.slice().sort((a, b) => strongSentences(b.sentences).length - strongSentences(a.sentences).length).slice(0, 3)) {
        for (const lk of (f.links || [])) {
          let abs; try { abs = new URL(lk, f.url).toString().split('#')[0]; } catch { continue; }
          if (!onApex(abs, apex) || seen.has(abs) || /\.(png|jpe?g|svg|gif|webp|css|js|json)$/i.test(abs)) continue;
          const sc = (/manage|create|register|setup|set-up|getting-started|dashboard|app-?(settings|registration)|consent|scopes?/i.test(abs) ? 2 : 0) + (/oauth|auth|sign-in/i.test(abs) ? 1 : 0);
          if (sc >= 2 && (!follow.has(abs) || follow.get(abs) < sc)) follow.set(abs, sc);
        }
      }
      const ft = [...follow.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map((e) => e[0]);
      if (ft.length) say(`Following ${ft.length} links to app-creation/management pages referenced by the OAuth docs`);
      const fr = await Promise.allSettled(ft.map(async (u) => {
        try { return { u, ...(await fetchPage(u.endsWith('.md') ? u : `${u}.md`, { anyText: true })) }; }
        catch { return { u, ...(await fetchPage(u, { anyText: true })) }; }
      }));
      for (const r2 of fr) {
        if (r2.status !== 'fulfilled') continue;
        const facts = extractEvidence(r2.value.html);
        if (strongSentences(facts.sentences).length < 2) continue;
        seen.add(r2.value.u);
        evidence.pages.push({ url: r2.value.finalUrl, requestedUrl: r2.value.u, ...facts });
        say(`Found app-creation/management page ${r2.value.finalUrl} (${strongSentences(facts.sentences).length} relevant passages)`);
      }
    }
    if (strongPassageCount(evidence.pages) < MIN_STRONG_PASSAGES) {
      try {
        const hits = await searchBing(`site:${apex} oauth register application client id redirect uri`);
        const fp = hits.filter((h) => onApex(h.url, apex) && !seen.has(h.url)).slice(0, 3);
        for (const h of fp) {
          try {
            say(`Fetching search result ${h.url}`);
            const { html, finalUrl } = await fetchPage(h.url);
            const facts = extractEvidence(html);
            seen.add(finalUrl);
            evidence.pages.push({ url: finalUrl, requestedUrl: h.url, ...facts });
            say(`Extracted ${strongSentences(facts.sentences).length} relevant passages from ${h.url}`);
          } catch (err) { say(`Skipped ${h.url}: ${err.message}`); }
        }
      } catch (err) { say(`Site-scoped search unavailable (${err.message})`); }
    }
  }
  return evidence;
}

module.exports = { strongPassageCount, MIN_STRONG_PASSAGES, investigate, normalizeQuery, extractEvidence, stripHtml, extractDeveloperLinks, searchDeveloperDocs, isBlockedUrl, isBlockedIp, apexOf, onApex, docScore };
