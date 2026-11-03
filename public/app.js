'use strict';

const cards = document.getElementById('cards');
const statusEl = document.getElementById('status');
const searchEl = document.getElementById('search');
const genform = document.getElementById('genform');
const genquery = document.getElementById('genquery');
const genlog = document.getElementById('genlog');
const genresult = document.getElementById('genresult');
const backendEl = document.getElementById('backend');

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function approvalShort(a) {
  if (a.required === true) return 'approval required';
  if (a.required === 'conditional') return 'approval in some cases';
  return 'no approval needed';
}

function renderCards(guides) {
  if (!guides.length) {
    cards.innerHTML = '<p class="muted">No library guide matches. Try generating one below.</p>';
    return;
  }
  cards.innerHTML = guides.map((g) => `
    <div class="card">
      <h3><a href="/guide/${esc(g.slug)}">${esc(g.app)}</a></h3>
      <p>${esc(g.summary)}</p>
      <div class="meta">
        <span class="tag diff-${esc(g.difficulty)}">${esc(g.difficulty)}</span>
        <span class="tag">${esc(approvalShort(g.approval))}</span>
        ${g.origin === 'generated' ? '<span class="tag tag-gen">agent-generated</span>' : ''}
        <span class="tag">checked ${esc(g.last_checked)}</span>
      </div>
    </div>`).join('');
}

async function load(q) {
  const res = await fetch('/api/guides' + (q ? `?q=${encodeURIComponent(q)}` : ''));
  const data = await res.json();
  statusEl.textContent = `${data.count} guide${data.count === 1 ? '' : 's'} in the library`;
  backendEl.textContent = data.agent.note;
  renderCards(data.guides);
}

let debounce;
searchEl.addEventListener('input', () => {
  clearTimeout(debounce);
  debounce = setTimeout(() => load(searchEl.value), 200);
});

function renderLog(entries) {
  genlog.innerHTML = entries.map((e) => `<li>${esc(e.line)}</li>`).join('');
  genlog.scrollTop = genlog.scrollHeight;
}

function renderResearch(r) {
  const pages = (r.pages || []).map((p) => `
    <div class="card">
      <h3><a href="${esc(p.url)}">${esc(p.title || p.url)}</a></h3>
      ${(p.headings || []).slice(0, 6).map((h) => `<p>&middot; ${esc(h)}</p>`).join('')}
    </div>`).join('');
  genresult.innerHTML = `
    <p class="badge warn">${esc(r.note)}</p>
    <h3>What the investigation found</h3>
    <div class="cards">${pages || '<p class="muted">No pages could be fetched.</p>'}</div>`;
}

async function pollJob(id) {
  const res = await fetch(`/api/jobs/${id}`);
  const job = await res.json();
  renderLog(job.log || []);
  if (job.status === 'running') {
    setTimeout(() => pollJob(id), 800);
    return;
  }
  genform.querySelector('button').disabled = false;
  if (job.status === 'done') {
    genresult.innerHTML = `<p class="badge ok">Guide generated with ${esc(job.backend)}</p>
      <p><a href="/guide/${esc(job.slug)}">Open the shareable guide</a> &middot;
      <a href="/api/guides/${esc(job.slug)}.md">download markdown</a></p>`;
    load(searchEl.value);
  } else if (job.status === 'research_only') {
    renderResearch(job.research);
  } else {
    genresult.innerHTML = `<p class="badge warn">Generation failed: ${esc(job.error)}</p>`;
  }
}

genform.addEventListener('submit', async (e) => {
  e.preventDefault();
  genresult.innerHTML = '';
  genlog.innerHTML = '';
  genform.querySelector('button').disabled = true;
  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: genquery.value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    pollJob(data.job_id);
  } catch (err) {
    genresult.innerHTML = `<p class="badge warn">${esc(err.message)}</p>`;
    genform.querySelector('button').disabled = false;
  }
});

load('');
