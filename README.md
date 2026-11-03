# OAuth Setup Guides

A working experience for developers and agent builders who need to create an
OAuth app with a provider and get it approved. Look up an app, get a shareable
guide that says how hard the setup is, how long it takes, what can block
approval, and what an agent can do versus where you take over. Or submit any
app name/website and let the agent investigate it and generate a guide live.

Built as a take-home for the Composio APM (Integrations) role.

## What it does

- **Guide library** - ready-to-use guides for 8 providers chosen for varied
  setup challenges: GitHub (instant, no review), Google (tiered verification
  up to ~6 weeks), Slack (self-serve distribution, reviewed Marketplace),
  Notion (explicitly no review to start OAuth), HubSpot (tiered scopes),
  LinkedIn (product-based gating), Salesforce (Spring '26 connected-app
  restriction), Spotify (5-user development mode, org-only quota extension).
- **Live generation** - submit an app name or website. An agent searches for
  the provider's real developer documentation, fetches the pages, extracts
  OAuth-relevant passages, and synthesizes a guide with a configured model
  backend. The generated guide is saved and gets its own shareable link.
- **Honesty by construction** - every step carries a source URL and a
  verified/unverified label; guides state what was checked and what remains
  uncertain. If no model backend is configured, the app returns the raw
  sourced investigation labeled as research, never a fake "guide".

## Live demo

https://oauth-setup-guides.onrender.com

Hosted on Render's free tier (no card). Caveats of the free tier: the service
sleeps after 15 idle minutes and takes about a minute to wake (Render shows a
loading page), and generated guides live on an ephemeral filesystem, so they
can disappear when the service restarts; the 8-guide library ships with the
code and is always present. The deployment stores the model key as a secret
environment variable, rate-limits requests (240 req/min per IP, 5 live
generations per 10 min per IP), caps query and page sizes, and blocks
internal-network fetch targets (SSRF guard).

## Running it

Requires Node 18+ (developed against Node 22 LTS). No dependencies to install.

```bash
node server.js
# open http://localhost:3000
```

Windows (PowerShell, Node 22) - set the model key and run:

```powershell
$env:GEMINI_API_KEY = "..."
node server.js
```

Tests:

```bash
npm test
```

## Enabling live guide generation

Investigation (search, fetch, extraction) always works with no keys. Guide
synthesis needs one of these no-card model backends:

1. **Google AI Studio free tier** - create a free API key at
   https://aistudio.google.com/apikey (no card required), then:
   `GEMINI_API_KEY=... node server.js` (POSIX; PowerShell syntax below)
2. **Local Ollama** - install Ollama, `ollama pull llama3.1:8b`, then:
   `USE_OLLAMA=1 node server.js`. The model runs on your machine; the
   investigation stage (search and documentation fetch) still uses the
   network, because live provider pages are the evidence.
3. **Bring your own OpenAI-compatible endpoint** - `OPENAI_API_KEY=...
   [OPENAI_BASE_URL=...] node server.js`. Whether this costs anything depends
   on the endpoint you point it at; the demo itself runs entirely on the
   free Gemini tier above, and no paid API is required for any part of it.

With none of these set, generation returns the sourced investigation clearly
labeled as research-only, with instructions to configure a backend.

## Key decisions

- **Focused scope:** setup guidance for provider OAuth apps, not a full
  integration builder. The Composio managed OAuth app directory
  (https://docs.composio.dev/toolkits/managed-auth) covers what a managed
  directory looks like; this project focuses on the "understand the path and
  what blocks approval" problem the brief describes.
- **JSON guide schema with per-step sources and verified flags**, so every
  claim is traceable and uncertainty is visible instead of smoothed over.
- **Zero runtime dependencies** (Node's stdlib only) so reviewers can run it
  with a single command on any machine, including Windows.
- **No paid APIs anywhere.** Model backends are free-tier or local; the
  investigation layer uses public search and the providers' own pages.
- **Generated guides persist** under `data/generated/` so a live demo
  produces a durable, shareable artifact (on the free host this storage is
  ephemeral - see Live demo caveats).

## How agents were used

Agents did the real investigation behind the library: fetching and reading
each provider's current official documentation on 2026-11-03, extracting the
setup, approval and timeline facts, and cross-checking claims (e.g. Google's
published verification timelines, Salesforce's Spring '26 connected-app
restriction, Spotify's May 2025 org-only quota policy). What was verified
against a fetched source is labeled with "source page fetched by server";
items the sources do not settle (e.g. an approval requirement the docs never
mention) are marked "unknown", not guessed.

Agents also attempted setup directly where that was possible without creating
real third-party apps: the GitHub OAuth app registration form was opened live
in the provider console on 2026-11-03 and its fields match the GitHub guide
(recorded in that guide's "How this was checked" note; no app was created).

A second agent pass reviewed the codebase itself: an independent frontier
model (Claude Sonnet, consulted through a public model arena) did a full
review of the investigation/synthesis code; its findings led to the SSRF
hardening, server-computed verified flags, evidence allow-listing, failure
degradation to preserved research, and the rate limits above.

## Limitations

- The library demonstrates 8 apps, not 100; the schema and pipeline scale to
  more, and live generation covers apps outside the library.
- Live synthesis quality depends on the configured model; weak evidence (a
  provider with thin docs) yields a thinner guide, and the model is
  constrained to the fetched evidence only.
- Search-based doc discovery can miss providers with unusual documentation
  layouts; the fallback is fetching known developer-site URL patterns.
- Review timelines quoted for library guides come from provider-published
  estimates; actual review times vary.
- Library guides are verified against provider documentation fetched on
  2026-11-03; provider consoles were NOT driven end-to-end for every guide
  (each guide carries a "How this was checked" note saying exactly this).
- Tests pass in CI on both ubuntu-latest and windows-latest with Node 22
  (GitHub Actions matrix, see .github/workflows/test.yml). stdlib only, no
  native modules, no platform-specific APIs. Developed on Linux Node 22.23.
- The SSRF guard blocks loopback/private/link-local fetch targets across
  redirect hops; the public deployment additionally uses secret env storage,
  per-IP rate limits and request bounds (see Live demo).
- Gemini's free tier rate-limits under demand; the client retries with
  backoff across fallback models, but a saturated API still fails visibly
  (job status error) instead of silently degrading.

## API

- `GET /api/guides?q=` - list/search library
- `GET /api/guides/:slug` - guide JSON
- `GET /guide/:slug` - shareable HTML guide page
- `GET /api/guides/:slug.md` - markdown export
- `POST /api/generate {"query": "figma.com"}` - start live generation
- `GET /api/jobs/:id` - generation progress/result
- `GET /api/status` - health + model backend status
