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
async function fetchPage(url) {
  if (isBlockedUrl(url)) throw new Error(`blocked by SSRF guard: ${url}`);
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const host = new URL(current).hostname;
    if (await resolvesPrivate(host)) throw new Error(`blocked: ${host} resolves to a private address`);
    const res = await fetch(current, {
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
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
    if (!type.includes('html')) throw new Error(`not html (${type}) for ${current}`);
    const text = await readCapped(res, MAX_BODY_CHARS);
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
  return { title: stripHtml(title).trim().slice(0, 160), headings, sentences };
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

async function investigate(rawQuery, log) {
  const say = log || (() => {});
  const query = normalizeQuery(rawQuery);
  say(`Resolving "${query.input}" (${query.kind})`);
  const evidence = { query, search_results: [], pages: [] };

  try {
    evidence.search_results = await searchDeveloperDocs(query.name, query.domain);
    say(`Search returned ${evidence.search_results.length} candidate doc links`);
  } catch (err) {
    say(`Search failed (${err.message}); falling back to direct URLs`);
  }

  const targets = [];
  for (const r of evidence.search_results.slice(0, 4)) targets.push(r.url);
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
  return evidence;
}

module.exports = { investigate, normalizeQuery, extractEvidence, stripHtml, extractDeveloperLinks, searchDeveloperDocs, isBlockedUrl, isBlockedIp };
