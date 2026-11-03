'use strict';

// Pluggable model backends for guide synthesis, all no-card routes:
//   1. Google AI Studio free tier (GEMINI_API_KEY) - free of charge, no card.
//   2. Local Ollama (OLLAMA_HOST, default http://localhost:11434) - fully offline.
//   3. Any OpenAI-compatible endpoint (OPENAI_API_KEY + optional OPENAI_BASE_URL)
//      for runners who already have a key.
// detectBackend() reports which route is live; the agent never pretends a
// synthesis happened without one of these.

function detectBackend(env = process.env) {
  if (env.GEMINI_API_KEY) {
    const model = env.GEMINI_MODEL || 'gemini-3.8-flash';
    return { kind: 'gemini', model, label: `Google AI Studio free tier (${model})` };
  }
  if (env.OLLAMA_MODEL || env.OLLAMA_HOST || ['1', 'true', 'yes'].includes(String(env.USE_OLLAMA || '').toLowerCase())) {
    return { kind: 'ollama', model: env.OLLAMA_MODEL || 'llama3.1:8b', host: env.OLLAMA_HOST || 'http://localhost:11434', label: `local Ollama (${env.OLLAMA_MODEL || 'llama3.1:8b'})` };
  }
  if (env.OPENAI_API_KEY) {
    return { kind: 'openai', model: env.OPENAI_MODEL || 'gpt-4o-mini', base: env.OPENAI_BASE_URL || 'https://api.openai.com/v1', label: `OpenAI-compatible (${env.OPENAI_MODEL || 'gpt-4o-mini'})` };
  }
  return null;
}

const SYSTEM_PROMPT = `You write OAuth app setup guides for developers as strict JSON.
Given evidence extracted from a provider's official pages, produce ONE JSON object with exactly these fields:
{
 "app": string, "website": string, "console_url": string|null (ONLY the page where a developer creates or registers the OAuth app, and ONLY if a fetched page states that URL; otherwise null - never a related product page),
 "difficulty": "easy"|"moderate"|"hard",
 "summary": string (2-3 sentences: how hard, how long, the main catch),
 "approval": {"required": true|false|"conditional"|"unknown" (use "unknown" when the fetched pages do not state approval requirements - never guess false), "typical_timeline": string, "notes": string},
 "steps": [{"title": string, "detail": string, "source": string (url), "verified": true}],
 "nuances": [string],
 "agent_can_do": [string],
 "human_must_do": [string],
 "sources": [{"title": string, "url": string}],
 "coverage": {"create_app": SLOT, "credentials": SLOT, "redirect_uri": SLOT, "scopes": SLOT, "approval": SLOT, "agent_human": SLOT}
}
SLOT = {"status": "covered"|"not_found", "passage": string (the [Pn] identifier of the numbered passage that supports this slot; "" if not_found), "quote": string (the SAME passage copied verbatim; "" if not_found), "url": string (that page)}
Slots: create_app = how a developer creates/registers the OAuth app or integration; credentials = where client id/secret come from; redirect_uri = how the redirect/callback URL is set; scopes = how scopes/permissions are chosen; approval = whether review/approval is required and how long it takes; agent_human = a documented step that needs a human (login, consent, review submission).
Use status "not_found" honestly when no fetched passage supports a slot. Never paraphrase a quote. Always fill "passage" with the exact [Pn] id of the passage your quote comes from.
Difficulty rubric (apply it, do not go by feel): easy = no review/approval and 4 or fewer dashboard steps; moderate = 5+ steps, extra verification, or conditional approval; hard = mandatory review/audit or business verification, or approval timing the docs call long. If approval is unknown, pick the level the steps alone justify and say so in summary.
agent_can_do = setup work an agent can prepare or do for the developer (drafting app name/description/redirect URLs, checking scopes against the docs, storing credentials in env vars, running a test authorization once a human has approved). It is NOT a description of the OAuth protocol. human_must_do = each action only the account owner can do (sign in, create the app in the console, accept terms, copy the secret, submit for review). Each item should name the concrete action. These two lists are your inference unless a quote documents them.
Rules: use ONLY facts present in the evidence. If the evidence does not say how long approval takes, say "not stated in fetched sources" instead of guessing. Every step needs a source url copied from the evidence. Mark anything uncertain in nuances. Output raw JSON only, no markdown fences.`;

// Deterministic numbered passage list shared by the prompt and the
// coverage gate: the model cites [Pn] and the server substitutes the exact
// fetched text, so a published quote is always literal evidence.
function passageIndex(evidence) {
  const out = [];
  let n = 0;
  for (const page of evidence.pages) {
    for (const sentence of (page.sentences || []).slice(0, 30)) {
      n += 1;
      out.push({ id: `P${n}`, url: page.url, sentence });
    }
  }
  return out;
}

function buildUserPrompt(evidence) {
  const parts = [`App query: ${evidence.query.input}`, ''];
  // Coverage-gate feedback from a rejected previous draft (verbatim quotes).
  if (evidence.feedback) parts.push(`FEEDBACK ON YOUR PREVIOUS DRAFT: ${evidence.feedback}`, '');
  const byUrl = new Map();
  for (const ref of passageIndex(evidence)) {
    if (!byUrl.has(ref.url)) byUrl.set(ref.url, []);
    byUrl.get(ref.url).push(ref);
  }
  for (const page of evidence.pages) {
    parts.push(`PAGE: ${page.url}`);
    if (page.title) parts.push(`Title: ${page.title}`);
    if (page.headings.length) parts.push(`Headings: ${page.headings.join(' | ')}`);
    const refs = byUrl.get(page.url) || [];
    if (refs.length) parts.push('Passages (cite as [Pn]):');
    for (const ref of refs) parts.push(`- [${ref.id}] ${ref.sentence}`);
    parts.push('');
  }
  if (!evidence.pages.length) parts.push('(No pages could be fetched; search result titles/URLs follow.)');
  for (const r of evidence.search_results) parts.push(`SEARCH RESULT: ${r.title} - ${r.url}`);
  return parts.join('\n');
}

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('model returned no JSON object');
  return JSON.parse(text.slice(start, end + 1));
}

const GEMINI_FALLBACK_MODELS = ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-3.1-pro-preview'];

async function callGemini(prompt, backend, env) {
  const models = [backend.model, ...GEMINI_FALLBACK_MODELS.filter((m) => m !== backend.model)];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let lastErr;
  for (const model of models) {
    // Free-tier capacity spikes are common: two bounded retries per model.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await callGeminiModel(prompt, model, env);
      } catch (err) {
        lastErr = err;
        const retriable = /HTTP (404|429|503)/.test(err.message) || /timed out|aborted|TimeoutError/i.test(err.message) || err.name === 'TimeoutError' || err.name === 'AbortError';
        if (!retriable) throw err;
        await sleep(3000 * (attempt + 1));
      }
    }
  }
  throw lastErr;
}

async function callGeminiModel(prompt, model, env) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(90000),
    headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, response_mime_type: 'application/json' },
    }),
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = (((data.candidates || [])[0] || {}).content || {}).parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned no text');
  return extractJson(text);
}

async function callOllama(prompt, backend) {
  const res = await fetch(`${backend.host.replace(/\/+$/, '')}/api/chat`, {
    signal: AbortSignal.timeout(120000),
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: backend.model,
      stream: false,
      format: 'json',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  if (!data.message || !data.message.content) throw new Error('Ollama returned no content');
  return extractJson(data.message.content);
}

async function callOpenAI(prompt, backend, env) {
  const res = await fetch(`${backend.base.replace(/\/+$/, '')}/chat/completions`, {
    signal: AbortSignal.timeout(90000),
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: backend.model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI-compatible HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenAI-compatible endpoint returned no text');
  return extractJson(text);
}

async function synthesize(evidence, env = process.env) {
  const backend = detectBackend(env);
  if (!backend) return { backend: null, guide: null };
  const prompt = buildUserPrompt(evidence);
  let guide;
  if (backend.kind === 'gemini') guide = await callGemini(prompt, backend, env);
  else if (backend.kind === 'ollama') guide = await callOllama(prompt, backend);
  else guide = await callOpenAI(prompt, backend, env);
  return { backend, guide };
}

module.exports = { detectBackend, synthesize, buildUserPrompt, passageIndex, SYSTEM_PROMPT };
