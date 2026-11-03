'use strict';

// The generation flow the assignment asks for: submit an app name or website,
// an agent investigates it against live public sources and generates a
// shareable guide. Jobs run in the background; the UI polls for progress.

const crypto = require('crypto');
const { investigate, strongPassageCount, MIN_STRONG_PASSAGES } = require('./investigate');
const { synthesize, detectBackend } = require('./llm');
const { validateGuide } = require('./guideSchema');
const { saveGenerated, getGuide } = require('./store');
const { pushGenerated } = require('./persist');

const jobs = new Map();

// Free-tier model capacity spikes (HTTP 503) can last minutes. A live demo
// must not die to them: after the model's own fast retry chain exhausts, the
// job keeps its investigation and retries synthesis from the same evidence.
const SYNTH_RETRY_DELAY_MS = 75000;
const MAX_SYNTH_RETRIES = 8;

function isRetriableModelError(err) {
  // 404 is permanent (wrong model id) - no retry. 429/5xx/capacity are transient.
  return /HTTP (429|5\d\d)/.test(err.message) || /high demand|UNAVAILABLE|timed out|TimeoutError|aborted/i.test(err.message);
}

function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'app';
}

function pushLog(job, line) {
  job.log.push({ at: new Date().toISOString(), line });
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function runJob(job) {
  const say = (line) => pushLog(job, line);
  try {
    say(`Investigating "${job.query}" against live public sources`);
    // Hard cap on investigation time: a stalled fetch must end as an honest
    // incomplete result, never an endless "running" job.
    const partial = { query: null, search_results: [], pages: [] };
    let timer;
    const evidence = await Promise.race([
      investigate(job.query, say, partial),
      new Promise((resolve) => { timer = setTimeout(() => { say('Investigation time limit (150s) reached; continuing with the pages fetched so far'); resolve(partial); }, 150000); }),
    ]);
    clearTimeout(timer);
    job.evidence_pages = evidence.pages.map((p) => p.url);

    const backend = detectBackend();
    if (!backend) {
      // No model backend configured: return the real investigation, honestly
      // labeled. This is not presented as a finished guide.
      job.status = 'research_only';
      job.research = {
        note: 'Investigation completed, but no model backend is configured, so synthesis did not run. Set GEMINI_API_KEY (free AI Studio tier), run local Ollama, or set OPENAI_API_KEY to enable full guide generation.',
        search_results: evidence.search_results,
        pages: evidence.pages.map((p) => ({ url: p.url, title: p.title, headings: p.headings, passages: p.sentences.slice(0, 15) })),
      };
      say('No model backend configured; returning sourced research instead of a synthesized guide');
      return;
    }

    if (evidence.pages.length === 0) {
      // Never synthesize from thin air: with no fetched provider pages the
      // model would write from training memory and still get last_checked.
      job.status = 'research_only';
      job.research = {
        note: 'No provider documentation could be fetched, so no guide was synthesized. Search result candidates are below; try the app\'s exact developer site URL.',
        search_results: evidence.search_results,
        pages: [],
      };
      say('No pages fetched; returning search candidates instead of synthesizing from memory');
      return;
    }
    // Stale-docs filter: drop pages whose URL or title marks them deprecated,
    // legacy or archived, but only if current pages remain.
    const STALE = /deprecat|legacy|archiv|\/v1(\/|$)|obsolete/i;
    const fresh = evidence.pages.filter((p) => !STALE.test(p.url) && !STALE.test(p.title || ''));
    if (fresh.length && fresh.length < evidence.pages.length) {
      say(`Ignoring ${evidence.pages.length - fresh.length} page(s) marked deprecated/legacy/archived`);
      evidence.pages = fresh;
    }
    const strong = strongPassageCount(evidence.pages);
    if (strong < MIN_STRONG_PASSAGES) {
      // Evidence gate: general product pages are not OAuth documentation.
      job.status = 'research_only';
      job.research = {
        note: `Not enough OAuth documentation was found for "${job.query}" (${strong} relevant passages across ${evidence.pages.length} first-party pages; at least ${MIN_STRONG_PASSAGES} are required), so no guide was generated. This is an incomplete investigation, not a finished guide. Try the provider's developer-docs URL directly.`,
        search_results: evidence.search_results,
        pages: evidence.pages.map((p) => ({ url: p.url, title: p.title, headings: p.headings })),
      };
      say(`Evidence gate: only ${strong} relevant OAuth passages found (need ${MIN_STRONG_PASSAGES}); not generating a guide from thin sources`);
      return;
    }
    await synthesizeAndPublish(job, evidence, say);
  } catch (err) {
    if (job.evidence_pages && job.evidence_pages.length) {
      job.status = 'research_only';
      job.research = { note: `Generation failed (${err.message.slice(0, 200)}); the investigation results are preserved below.`, search_results: [], pages: [] };
      say(`Failed, evidence preserved: ${err.message}`);
    } else {
      job.status = 'error';
      job.error = err.message;
      say(`Failed: ${err.message}`);
    }
  }
}

// Build the publishable candidate from model output + fetched evidence.
// Everything honest lives here: whitelisted fields, host-gated URLs,
// server-computed verified flags, and the verbatim-quote coverage gate.
function buildCandidate(job, evidence, guide) {
  const fetchedHosts = new Set(evidence.pages.map((p) => { try { return new URL(p.url).hostname.replace(/^www\./, ''); } catch { return ''; } }));
  const fetchedUrls = new Set(evidence.pages.map((p) => p.url));
  // verified requires more than a host match: the step's own words must
  // overlap the passages actually extracted from its cited page.
  const passageTextByUrl = new Map(evidence.pages.map((p) => [
    p.url,
    `${p.title || ''} ${(p.headings || []).join(' ')} ${(p.sentences || []).join(' ')}`.toLowerCase(),
  ]));
  const normUrl = (u) => String(u || '').replace(/[#?].*$/, '').replace(/\.md$/i, '').replace(/\/+$/, '').toLowerCase();
  for (const [u, t] of [...passageTextByUrl]) if (!passageTextByUrl.has(normUrl(u))) passageTextByUrl.set(normUrl(u), t);
  const mentionsUrlExactly = (text, url) => {
    const esc = String(url).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(esc + '(?![A-Za-z0-9/_.#?=&%-])').test(text);
  };
  const contentWords = (text) => String(text).toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) || [];
  const stepSupported = (step) => {
    const pageText = passageTextByUrl.get(step.source) || passageTextByUrl.get(normUrl(step.source));
    if (!pageText) return false;
    const words = contentWords(`${step.title} ${step.detail || ''}`)
      .filter((w) => !['oauth', 'http', 'https', 'com', 'www', 'your', 'with', 'from', 'that', 'this'].includes(w));
    if (!words.length) return true;
    const hits = new Set(words.filter((w) => pageText.includes(w)));
    return hits.size >= Math.min(2, new Set(words).size);
  };
  const onEvidence = (u) => {
    try { return fetchedHosts.has(new URL(u).hostname.replace(/^www\./, '')); } catch { return false; }
  };
  // Whitelist schema fields; never spread raw model output into the guide.
  const candidate = {
    slug: `gen-${slugify(guide.app || job.query)}-${job.id.slice(0, 6)}`,
    app: String(guide.app || job.query).slice(0, 80),
    website: onEvidence(guide.website) ? guide.website : undefined,
    console_url: onEvidence(guide.console_url) && evidence.pages.some((p) => (p.links || []).includes(guide.console_url) || (p.sentences || []).some((x) => mentionsUrlExactly(x, guide.console_url)) || p.url === guide.console_url) ? guide.console_url : null,
    difficulty: guide.difficulty,
    summary: String(guide.summary || '').slice(0, 600),
    approval: guide.approval && typeof guide.approval === 'object' ? (() => {
      const timeline = String(guide.approval.typical_timeline || 'not stated in fetched sources').slice(0, 300);
      const notes = String(guide.approval.notes || '').slice(0, 400);
      let required = guide.approval.required;
      // Source-support semantics: if the model's own text says the sources
      // do not state approval requirements, it may not claim "not required".
      const admitsUnknown = /not stated|does not (state|mention)|no mention|not specified|not mention/i.test(notes);
      if ((required === false || required === 'conditional') && admitsUnknown) required = 'unknown';
      if (required == null) required = 'unknown';
      return { required, typical_timeline: timeline, notes };
    })() : undefined,
    steps: (Array.isArray(guide.steps) ? guide.steps : []).slice(0, 12).map((s) => ({
      title: String((s || {}).title || '').slice(0, 140),
      detail: String((s || {}).detail || '').slice(0, 600),
      source: (s || {}).source,
      // verified is computed server-side: the cited page must actually
      // have been fetched AND its extracted passages must share content
      // words with the step, so a citation cannot lean on a bare host match.
      verified: (() => { const st = { source: (s || {}).source, title: String((s || {}).title || ''), detail: String((s || {}).detail || '') }; return (fetchedUrls.has(st.source) || [...fetchedUrls].some((f) => normUrl(f) === normUrl(st.source))) && stepSupported(st); })(),
    })),
    nuances: (Array.isArray(guide.nuances) ? guide.nuances : []).slice(0, 12).map((n) => String(n).slice(0, 300)),
    agent_can_do: (Array.isArray(guide.agent_can_do) ? guide.agent_can_do : []).slice(0, 8).map((n) => String(n).slice(0, 200)),
    human_must_do: (Array.isArray(guide.human_must_do) ? guide.human_must_do : []).slice(0, 8).map((n) => String(n).slice(0, 200)),
    sources: (Array.isArray(guide.sources) ? guide.sources : [])
      .filter((s) => s && onEvidence(s.url))
      .map((s) => ({ title: String(s.title || s.url).slice(0, 160), url: s.url })),
    testing: { console_attempted: false, note: 'Generated by an agent from fetched public pages listed in sources; provider console was not driven. verified steps cite a page that was actually fetched.' },
    last_checked: today(),
  };
  if (!candidate.sources.length) {
    candidate.sources = evidence.pages.map((p) => ({ title: p.title || p.url, url: p.url }));
  }
  // Slot-coverage gate: each slot must be backed by a VERBATIM quote that
  // really occurs in a fetched page. The server checks the quote itself.
  const norm = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim();
  const pageBlobs = evidence.pages.map((p) => ({ url: p.url, text: norm(`${p.title || ''} ${(p.headings || []).join(' ')} ${(p.sentences || []).join(' ')}`) }));
  const SLOTS = ['create_app', 'credentials', 'redirect_uri', 'scopes', 'approval', 'agent_human'];
  const coverage = {};
  for (const slot of SLOTS) {
    const c = (guide.coverage || {})[slot] || {};
    const q = norm(c.quote);
    const blob = pageBlobs.find((b) => b.url === c.url) || null;
    let ok = c.status === 'covered' && q.length >= 25 && ((blob && blob.text.includes(q)) || pageBlobs.some((b) => b.text.includes(q)));
    // Intent check: a create_app quote must actually describe creating or
    // registering an OAuth app/client at the provider - a creation verb AND
    // an app/credential term - not merely mention OAuth (consumer-side docs).
    if (slot === 'create_app' && ok && !(/creat|regist|new app|add (a|an|the)|set up/.test(q) && /oauth|client|app|credential|secret|redirect|callback/.test(q))) ok = false;
    coverage[slot] = ok ? { status: 'verified', url: (blob && blob.text.includes(q)) ? blob.url : (pageBlobs.find((b) => b.text.includes(q)) || {}).url, quote: String(c.quote).slice(0, 240) } : { status: 'not_found' };
  }
  candidate.coverage = coverage;
  const REQUIRED_SLOTS = ['create_app', 'credentials', 'redirect_uri'];
  const missingSlots = REQUIRED_SLOTS.filter((sl) => coverage[sl].status !== 'verified');
  return { candidate, coverage, missingSlots };
}

// Synthesize from preserved evidence and publish. On a temporary model error
// the job stays "running" and retries from the same evidence; only after
// MAX_SYNTH_RETRIES failures does it end as an honest research_only result.
async function synthesizeAndPublish(job, evidence, say) {
  let backend, guide;
  // Awaited retry loop: runJob stays pending for the whole retry window, so
  // callers observe the true terminal state instead of resolving early.
  for (;;) {
    try {
      say(`Synthesizing guide with ${detectBackend().label}`);
      const r = await synthesize(evidence);
      backend = r.backend;
      guide = r.guide;
      break;
    } catch (err) {
      job.synth_failures = (job.synth_failures || 0) + 1;
      if (job.synth_failures <= MAX_SYNTH_RETRIES && isRetriableModelError(err)) {
        say(`Temporary model error (${err.message.slice(0, 120)}); the investigation is kept and synthesis retries automatically in ~75s (retry ${job.synth_failures} of ${MAX_SYNTH_RETRIES})`);
        await new Promise((resolve) => setTimeout(resolve, SYNTH_RETRY_DELAY_MS));
        continue;
      }
      job.status = 'research_only';
      job.research = {
        note: `Synthesis failed ${job.synth_failures > 1 ? `${job.synth_failures} times over several minutes` : ''} (${err.message.slice(0, 200)}); the investigation results are preserved below.`,
        search_results: [],
        pages: evidence.pages.map((p) => ({ url: p.url, title: p.title, headings: p.headings })),
      };
      say(`Synthesis failed after ${job.synth_failures} attempt(s), evidence preserved: ${err.message}`);
      return;
    }
  }
  let candidate;
  // The coverage gate never weakens - but a rejected draft gets ONE feedback
  // round so the model can fix paraphrased quotes against the same evidence.
  for (let pass = 0; pass < 2; pass++) {
    let built;
    try {
      built = buildCandidate(job, evidence, guide);
    } catch (err) {
      job.status = 'research_only';
      job.research = {
        note: `Publishing failed (${err.message.slice(0, 200)}); the investigation results are preserved below.`,
        search_results: [],
        pages: evidence.pages.map((p) => ({ url: p.url, title: p.title, headings: p.headings })),
      };
      say(`Failed, evidence preserved: ${err.message}`);
      return;
    }
    candidate = built.candidate;
    const missingSlots = built.missingSlots;
    if (!missingSlots.length) break;
    if (pass === 0) {
      say(`Coverage gate: no verbatim supporting quote for ${missingSlots.join(', ')}; re-synthesizing once with that feedback`);
      evidence.feedback = `Your previous draft's coverage quote for ${missingSlots.join(', ')} was not a verbatim match of any fetched passage. For each of those slots, copy ONE short sentence exactly as it appears in the passages above (same words, same order), or mark the slot not_found. Do not paraphrase or blend sentences.`;
      // Re-synthesize from the same evidence with the feedback attached.
      try {
        say(`Synthesizing guide with ${detectBackend().label}`);
        const r = await synthesize(evidence);
        guide = r.guide;
      } catch (err) {
        job.status = 'research_only';
        job.research = {
          note: `Synthesis failed on the coverage feedback pass (${err.message.slice(0, 200)}); the investigation results are preserved below.`,
          search_results: [],
          pages: evidence.pages.map((p) => ({ url: p.url, title: p.title, headings: p.headings })),
        };
        say(`Synthesis failed on feedback pass, evidence preserved: ${err.message}`);
        return;
      }
      continue;
    }
    job.status = 'research_only';
    job.research = {
      note: `The fetched documentation did not verifiably cover: ${missingSlots.join(', ').replace(/_/g, ' ')}. A setup guide without those would mislead, so none was published. This is an incomplete investigation; the pages reviewed are listed below.`,
      search_results: [],
      pages: evidence.pages.map((p) => ({ url: p.url, title: p.title, headings: p.headings })),
    };
    say(`Coverage gate: no verbatim supporting quote for ${missingSlots.join(', ')} after a feedback retry; not publishing`);
    return;
  }
  try {
    const errors = validateGuide(candidate);
    if (errors.length) {
      job.status = 'error';
      job.error = `Model output failed guide validation: ${errors.join('; ')}`;
      say(job.error);
      return;
    }
    // Output gate: a guide with almost no steps or empty agent/human sections
    // is a non-answer; surface it as an incomplete investigation instead.
    const verifiedSteps = candidate.steps.filter((st) => st.verified).length;
    if (candidate.steps.length < 3 || verifiedSteps < 2 || !candidate.agent_can_do.length || !candidate.human_must_do.length) {
      job.status = 'research_only';
      job.research = {
        note: `The generated draft was too thin to publish (${candidate.steps.length} steps, ${verifiedSteps} docs-backed, ${candidate.agent_can_do.length} agent actions, ${candidate.human_must_do.length} human actions). No guide was saved. This is an incomplete investigation; the sources reviewed are listed below.`,
        search_results: [],
        pages: evidence.pages.map((p) => ({ url: p.url, title: p.title, headings: p.headings })),
      };
      say('Quality gate: draft too thin (needs 3+ steps, 2+ docs-backed, and non-empty agent/human sections); not publishing');
      return;
    }
    saveGenerated(candidate);
    job.status = 'done';
    job.slug = candidate.slug;
    job.backend = backend.label;
    say(`Guide ready: /guide/${candidate.slug}`);
    pushGenerated(candidate).then((ok) => pushLog(job, ok ? 'Guide committed to the repository so its link survives restarts' : 'Guide kept in memory only; its link may not survive a restart')).catch(() => {});
  } catch (err) {
    // Publishing/validation failed after a successful synthesis: preserve the
    // investigation rather than dropping to a bare error.
    job.status = 'research_only';
    job.research = {
      note: `Publishing failed (${err.message.slice(0, 200)}); the investigation results are preserved below.`,
      search_results: [],
      pages: evidence.pages.map((p) => ({ url: p.url, title: p.title, headings: p.headings })),
    };
    say(`Failed, evidence preserved: ${err.message}`);
  }
}

function startGeneration(query) {
  if (!query || !String(query).trim()) throw new Error('query is required');
  const id = crypto.randomBytes(6).toString('hex');
  const trimmed = String(query).trim().slice(0, 200);
  for (const [jid, j] of jobs) { // evict jobs older than an hour
    if (Date.now() - new Date(j.created_at).getTime() > 3600000) jobs.delete(jid);
  }
  const job = { id, query: trimmed, status: 'running', log: [], created_at: new Date().toISOString() };
  jobs.set(id, job);
  pushLog(job, 'Job accepted');
  runJob(job);
  return job;
}

function getJob(id) {
  const job = jobs.get(id);
  if (!job) return null;
  const out = { ...job };
  delete out.research?.pages?.sentences;
  if (job.status === 'done' && job.slug) out.guide = getGuide(job.slug);
  return out;
}

function agentStatus() {
  const backend = detectBackend();
  return {
    model_backend: backend ? backend.label : null,
    generation_ready: Boolean(backend),
    note: backend
      ? `Live generation uses ${backend.label}.`
      : 'No model backend configured. Investigation still runs; synthesis needs GEMINI_API_KEY (free tier), local Ollama, or OPENAI_API_KEY.',
  };
}

module.exports = { startGeneration, getJob, agentStatus };
