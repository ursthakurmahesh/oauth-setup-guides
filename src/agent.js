'use strict';

// The generation flow the assignment asks for: submit an app name or website,
// an agent investigates it against live public sources and generates a
// shareable guide. Jobs run in the background; the UI polls for progress.

const crypto = require('crypto');
const { investigate, strongPassageCount, MIN_STRONG_PASSAGES } = require('./investigate');
const { synthesize, detectBackend } = require('./llm');
const { validateGuide } = require('./guideSchema');
const { saveGenerated, getGuide } = require('./store');

const jobs = new Map();

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
    const evidence = await Promise.race([
      investigate(job.query, say, partial),
      new Promise((resolve) => setTimeout(() => { say('Investigation time limit (150s) reached; continuing with the pages fetched so far'); resolve(partial); }, 150000)),
    ]);
    job.evidence_pages = evidence.pages.map((p) => p.url);

    const { backend, guide } = await synthesize(evidence);
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
    say(`Synthesizing guide with ${backend.label}`);
    const fetchedHosts = new Set(evidence.pages.map((p) => { try { return new URL(p.url).hostname.replace(/^www\./, ''); } catch { return ''; } }));
    const fetchedUrls = new Set(evidence.pages.map((p) => p.url));
    // verified requires more than a host match: the step's own words must
    // overlap the passages actually extracted from its cited page.
    const passageTextByUrl = new Map(evidence.pages.map((p) => [
      p.url,
      `${p.title || ''} ${(p.headings || []).join(' ')} ${(p.sentences || []).join(' ')}`.toLowerCase(),
    ]));
    const contentWords = (text) => String(text).toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) || [];
    const stepSupported = (step) => {
      const pageText = passageTextByUrl.get(step.source);
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
      console_url: onEvidence(guide.console_url) && evidence.pages.some((p) => (p.links || []).includes(guide.console_url) || (p.sentences || []).some((x) => x.includes(guide.console_url)) || p.url === guide.console_url) ? guide.console_url : null,
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
        verified: (() => { const st = { source: (s || {}).source, title: String((s || {}).title || ''), detail: String((s || {}).detail || '') }; return fetchedUrls.has(st.source) && stepSupported(st); })(),
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
      const ok = c.status === 'covered' && q.length >= 25 && ((blob && blob.text.includes(q)) || pageBlobs.some((b) => b.text.includes(q)));
      coverage[slot] = ok ? { status: 'verified', url: (blob && blob.text.includes(q)) ? blob.url : (pageBlobs.find((b) => b.text.includes(q)) || {}).url, quote: String(c.quote).slice(0, 240) } : { status: 'not_found' };
    }
    candidate.coverage = coverage;
    const REQUIRED_SLOTS = ['create_app', 'credentials', 'redirect_uri'];
    const missingSlots = REQUIRED_SLOTS.filter((sl) => coverage[sl].status !== 'verified');
    if (missingSlots.length) {
      job.status = 'research_only';
      job.research = {
        note: `The fetched documentation did not verifiably cover: ${missingSlots.join(', ').replace(/_/g, ' ')}. A setup guide without those would mislead, so none was published. This is an incomplete investigation; the pages reviewed are listed below.`,
        search_results: [],
        pages: evidence.pages.map((p) => ({ url: p.url, title: p.title, headings: p.headings })),
      };
      say(`Coverage gate: no verbatim supporting quote for ${missingSlots.join(', ')}; not publishing`);
      return;
    }
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
  } catch (err) {
    if (job.evidence_pages && job.evidence_pages.length) {
      job.status = 'research_only';
      job.research = { note: `Synthesis failed (${err.message.slice(0, 200)}); the investigation results are preserved below.`, search_results: [], pages: [] };
      say(`Synthesis failed, evidence preserved: ${err.message}`);
    } else {
      job.status = 'error';
      job.error = err.message;
      say(`Failed: ${err.message}`);
    }
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
