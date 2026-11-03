'use strict';

// The generation flow the assignment asks for: submit an app name or website,
// an agent investigates it against live public sources and generates a
// shareable guide. Jobs run in the background; the UI polls for progress.

const crypto = require('crypto');
const { investigate } = require('./investigate');
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
    const evidence = await investigate(job.query, say);
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

    say(`Synthesizing guide with ${backend.label}`);
    const candidate = {
      ...guide,
      slug: `gen-${slugify(guide.app || job.query)}-${job.id.slice(0, 6)}`,
      last_checked: today(),
    };
    if (!Array.isArray(candidate.sources) || candidate.sources.length === 0) {
      candidate.sources = evidence.pages.map((p) => ({ title: p.title || p.url, url: p.url }));
    }
    const errors = validateGuide(candidate);
    if (errors.length) {
      job.status = 'error';
      job.error = `Model output failed guide validation: ${errors.join('; ')}`;
      say(job.error);
      return;
    }
    saveGenerated(candidate);
    job.status = 'done';
    job.slug = candidate.slug;
    job.backend = backend.label;
    say(`Guide ready: /guide/${candidate.slug}`);
  } catch (err) {
    job.status = 'error';
    job.error = err.message;
    say(`Failed: ${err.message}`);
  }
}

function startGeneration(query) {
  if (!query || !String(query).trim()) throw new Error('query is required');
  const id = crypto.randomBytes(6).toString('hex');
  const job = { id, query: String(query).trim(), status: 'running', log: [], created_at: new Date().toISOString() };
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
