'use strict';

// Best-effort persistence of generated guides to the GitHub repo. Render's
// free tier has an ephemeral filesystem, so without this a generated guide's
// shareable link dies on restart. Active only when GITHUB_TOKEN and
// GITHUB_REPO (owner/name) are set; otherwise every call is a logged no-op.
// Sync failures never fail a generation job.

const path = require('path');
const fs = require('fs');
const { validateGuide } = require('./guideSchema');

const GENERATED_DIR = path.join(__dirname, '..', 'data', 'generated');
// Dedicated branch for runtime-written data: committing generated guides to
// main would trigger Render's auto-deploy on every generation and restart the
// service mid-job. The data branch carries data/generated/** only.
const DATA_BRANCH = 'generated-data';

function cfg(env = process.env) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return null;
  return { token: env.GITHUB_TOKEN, repo: env.GITHUB_REPO };
}

async function gh(method, url, token, body) {
  const res = await fetch(url, {
    method,
    signal: AbortSignal.timeout(20000),
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return res.json();
}

async function ensureDataBranch(c) {
  try { await gh('GET', `https://api.github.com/repos/${c.repo}/git/ref/heads/${DATA_BRANCH}`, c.token); return; } catch { /* create below */ }
  const main = await gh('GET', `https://api.github.com/repos/${c.repo}/git/ref/heads/main`, c.token);
  await gh('POST', `https://api.github.com/repos/${c.repo}/git/refs`, c.token, { ref: `refs/heads/${DATA_BRANCH}`, sha: main.object.sha });
}

async function pushGenerated(guide, log = console.error, env = process.env) {
  const c = cfg(env);
  if (!c) { log('persist: GITHUB_TOKEN/GITHUB_REPO not set; generated guide lives only until the next restart'); return false; }
  try {
    await ensureDataBranch(c);
    const file = `data/generated/${guide.slug}.json`;
    const url = `https://api.github.com/repos/${c.repo}/contents/${file}`;
    let sha;
    try { sha = (await gh('GET', `${url}?ref=${DATA_BRANCH}`, c.token)).sha; } catch { /* new file */ }
    await gh('PUT', url, c.token, {
      message: `Persist generated guide ${guide.slug}`,
      branch: DATA_BRANCH,
      content: Buffer.from(JSON.stringify(guide, null, 2)).toString('base64'),
      ...(sha ? { sha } : {}),
    });
    log(`persist: committed ${file} to ${c.repo}`);
    return true;
  } catch (err) {
    log(`persist: could not commit generated guide (${err.message}); link lives only until the next restart`);
    return false;
  }
}

async function pullGenerated(log = console.error, env = process.env) {
  const c = cfg(env);
  if (!c) return 0;
  try {
    let entries;
    try {
      entries = await gh('GET', `https://api.github.com/repos/${c.repo}/contents/data/generated?ref=${DATA_BRANCH}`, c.token);
    } catch { return 0; } // no data branch/dir yet: nothing to restore
    let n = 0;
    for (const e of Array.isArray(entries) ? entries : []) {
      if (!e.name.endsWith('.json')) continue;
      const local = path.join(GENERATED_DIR, e.name);
      if (fs.existsSync(local)) continue;
      try {
        const file = await gh('GET', e.url, c.token);
        const parsed = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
        // Revalidate before serving: repo contents are data, not truth. A
        // javascript: console_url or malformed guide must not reach the UI.
        const errs = validateGuide(parsed);
        if (errs.length) { log(`persist: skipping ${e.name} (fails validation: ${errs[0]})`); continue; }
        if (parsed.console_url && !/^https:\/\//i.test(parsed.console_url)) parsed.console_url = null;
        fs.mkdirSync(GENERATED_DIR, { recursive: true });
        fs.writeFileSync(local, JSON.stringify(parsed, null, 2));
        n += 1;
      } catch (err) {
        log(`persist: skipping ${e.name} (${err.message})`);
      }
    }
    if (n) log(`persist: restored ${n} generated guide(s) from ${c.repo}`);
    return n;
  } catch (err) {
    log(`persist: could not restore generated guides (${err.message})`);
    return 0;
  }
}

module.exports = { pushGenerated, pullGenerated };
