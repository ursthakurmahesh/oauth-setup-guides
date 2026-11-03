'use strict';

// Zero-dependency Node server (Node 18+, verified target Node 22 LTS).
// Serves the guide library, shareable guide pages, and the live generation flow.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { listGuides, getGuide, searchGuides } = require('./src/store');
const { startGeneration, getJob, agentStatus } = require('./src/agent');
const { guideToMarkdown } = require('./src/markdown');
const { estimateEffort } = require('./src/effort');
const { pullGenerated } = require('./src/persist');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body, null, 2));
}

function sendJson(res, status, obj) { send(res, status, obj); }

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function guideSummary(g) {
  return {
    slug: g.slug, app: g.app, website: g.website || null, difficulty: g.difficulty,
    summary: g.summary, approval: g.approval, last_checked: g.last_checked, origin: g.origin,
  };
}

// Server-rendered shareable guide page (no JS needed to read it).
function renderGuidePage(g) {
  const badge = g.origin === 'generated' ? '<span class="tag tag-gen">agent-generated</span>' : '<span class="tag">library</span>';
  const steps = g.steps.map((s) => `
    <li>
      <strong>${escapeHtml(s.title)}</strong>
      <span class="badge ${s.verified ? 'ok' : 'warn'}">${s.verified ? 'source page fetched by server' : 'no fetched source page backs this step'}</span>
      ${s.detail ? `<p>${escapeHtml(s.detail)}</p>` : ''}
      ${s.source ? `<p class="src"><a href="${escapeHtml(s.source)}">source</a></p>` : ''}
    </li>`).join('');
  const list = (items) => (items || []).map((n) => `<li>${escapeHtml(n)}</li>`).join('');
  const sources = (g.sources || []).map((s) => `<li><a href="${escapeHtml(s.url)}">${escapeHtml(s.title || s.url)}</a></li>`).join('');
  const css = fs.readFileSync(path.join(PUBLIC_DIR, 'styles.css'), 'utf8');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OAuth setup guide: ${escapeHtml(g.app)}</title><style>${css}</style></head>
<body><main class="guide">
<p><a href="/">&larr; all guides</a> &middot; <a href="/api/guides/${encodeURIComponent(g.slug)}.md">download markdown</a></p>
<h1>OAuth setup guide: ${escapeHtml(g.app)}</h1>
<p>${badge} <span class="muted">last checked ${escapeHtml(g.last_checked)}</span></p>
<p class="summary">${escapeHtml(g.summary)}</p>
<dl class="facts">
<dt>Difficulty</dt><dd>${escapeHtml(g.difficulty)}</dd>
<dt>Expected time / effort</dt><dd>${escapeHtml(estimateEffort(g).text)}; approval wait: ${escapeHtml(g.approval.typical_timeline)}</dd>
<dt>Approval</dt><dd>${g.approval.required === true ? 'required' : g.approval.required === 'conditional' ? 'required only in some cases' : g.approval.required === 'unknown' ? 'unknown - not stated in the fetched sources' : 'not required to start (per the fetched sources)'}${g.approval.notes ? ` - ${escapeHtml(g.approval.notes)}` : ''}</dd>
${g.console_url ? `<dt>Developer console</dt><dd><a href="${escapeHtml(g.console_url)}">${escapeHtml(g.console_url)}</a></dd>` : ''}
${g.coverage ? `<dt>Evidence coverage</dt><dd>${['create_app','credentials','redirect_uri','scopes','approval','agent_human'].map((k) => `${k.replace(/_/g, ' ')}: ${g.coverage[k] && g.coverage[k].status === 'verified' ? 'quote found in a fetched page' : 'not found in fetched pages'}`).map(escapeHtml).join('<br>')}</dd>` : ''}
${g.testing ? `<dt>How this was checked</dt><dd>${escapeHtml(g.testing.note)}</dd>` : ''}
</dl>
<h2>Steps</h2><ol class="steps">${steps}</ol>
${g.nuances.length ? `<h2>Nuances and gotchas</h2><ul>${list(g.nuances)}</ul>` : ''}
<h2>What an agent can do for you</h2><ul>${list(g.agent_can_do)}</ul>
<h2>Where you need to take over</h2><ul>${list(g.human_must_do)}</ul>
<h2>Sources</h2><ul>${sources}</ul>
</main></body></html>`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 100000) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('invalid JSON body')); } });
    req.on('error', reject);
  });
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'forbidden', 'text/plain');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'not found', 'text/plain');
    send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
  });
}

// Minimal abuse protection for a public deployment: fixed-window per-IP
// limits (zero-dependency, in-memory). Tighten behind a real proxy for
// production traffic.
const rateBuckets = new Map();
function rateLimited(ip, limit, windowMs) {
  const now = Date.now();
  let b = rateBuckets.get(ip);
  if (!b || now - b.start > windowMs) { b = { start: now, count: 0 }; rateBuckets.set(ip, b); }
  b.count += 1;
  if (rateBuckets.size > 10000) rateBuckets.clear();
  return b.count > limit;
}
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (typeof fwd === 'string' && fwd.split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  const ip = clientIp(req);
  if (rateLimited(`all:${ip}`, 240, 60000)) {
    res.writeHead(429, { 'content-type': 'application/json; charset=utf-8', 'retry-after': '60' });
    return res.end(JSON.stringify({ error: 'rate limit exceeded, retry later' }));
  }
  try {
    if (req.method === 'GET' && p === '/api/guides') {
      const term = url.searchParams.get('q');
      const guides = (term ? searchGuides(term) : listGuides()).map(guideSummary);
      return sendJson(res, 200, { count: guides.length, agent: agentStatus(), guides });
    }
    const mdMatch = p.match(/^\/api\/guides\/([a-z0-9-]+)\.md$/);
    if (req.method === 'GET' && mdMatch) {
      const g = getGuide(mdMatch[1]);
      if (!g) return sendJson(res, 404, { error: 'guide not found' });
      return send(res, 200, guideToMarkdown(g), MIME['.md']);
    }
    const apiMatch = p.match(/^\/api\/guides\/([a-z0-9-]+)$/);
    if (req.method === 'GET' && apiMatch) {
      const g = getGuide(apiMatch[1]);
      if (!g) return sendJson(res, 404, { error: 'guide not found' });
      return sendJson(res, 200, g);
    }
    const pageMatch = p.match(/^\/guide\/([a-z0-9-]+)$/);
    if (req.method === 'GET' && pageMatch) {
      const g = getGuide(pageMatch[1]);
      if (!g) return send(res, 404, '<h1>guide not found</h1>', 'text/html; charset=utf-8');
      return send(res, 200, renderGuidePage(g), 'text/html; charset=utf-8');
    }
    if (req.method === 'POST' && p === '/api/generate') {
      if (rateLimited(`gen:${ip}`, 5, 600000)) {
        res.writeHead(429, { 'content-type': 'application/json; charset=utf-8', 'retry-after': '600' });
        return res.end(JSON.stringify({ error: 'generation rate limit exceeded (5 per 10 minutes per IP)' }));
      }
      const body = await readBody(req);
      const job = startGeneration(body.query);
      return sendJson(res, 202, { job_id: job.id, status: job.status });
    }
    const jobMatch = p.match(/^\/api\/jobs\/([a-f0-9]{12})$/);
    if (req.method === 'GET' && jobMatch) {
      const job = getJob(jobMatch[1]);
      if (!job) return sendJson(res, 404, { error: 'job not found' });
      return sendJson(res, 200, job);
    }
    if (req.method === 'GET' && p === '/api/status') {
      return sendJson(res, 200, { ok: true, revision: process.env.RENDER_GIT_COMMIT || 'local', agent: agentStatus(), guides: listGuides().length });
    }
    if (req.method === 'GET' && (p === '/' || p.startsWith('/static/') || p === '/app.js' || p === '/styles.css')) {
      return serveStatic(res, p === '/' ? '/' : p.replace(/^\/static\//, '/'));
    }
    return sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    return sendJson(res, err.message === 'invalid JSON body' || err.message === 'query is required' ? 400 : 500, { error: err.message });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`oauth-setup-guides listening on http://localhost:${PORT}`);
    console.log(agentStatus().note);
    pullGenerated().then((n) => { if (n) console.log(`restored ${n} generated guide(s) from the repository`); });
  });
}

module.exports = { server, renderGuidePage };
