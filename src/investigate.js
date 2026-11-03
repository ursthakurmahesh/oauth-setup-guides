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

async function fetchPage(url) {
  const res = await withTimeout(fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
    redirect: 'follow',
  }), FETCH_TIMEOUT_MS, url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const type = res.headers.get('content-type') || '';
  if (!type.includes('html')) throw new Error(`not html (${type}) for ${url}`);
  const text = await res.text();
  return text.slice(0, MAX_PAGE_BYTES);
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
  return /duckduckgo|youtube|facebook|wikipedia\.org|bing\.com|microsoft\.com\/search|merriam|dictionary|cambridge/.test(href);
}

async function searchDuckDuckGo(terms) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(terms)}`;
  const html = await fetchPage(url);
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
    const apex = d.split('.').slice(-2).join('.');
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
      const html = await fetchPage(url);
      const facts = extractEvidence(html);
      evidence.pages.push({ url, ...facts });
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
      const html = await fetchPage(url);
      const facts = extractEvidence(html);
      evidence.pages.push({ url, ...facts });
      say(`Extracted ${facts.sentences.length} OAuth-related passages from ${url}`);
    } catch (err) {
      say(`Skipped ${url}: ${err.message}`);
    }
  }
  return evidence;
}

module.exports = { investigate, normalizeQuery, extractEvidence, stripHtml, extractDeveloperLinks, searchDeveloperDocs };
