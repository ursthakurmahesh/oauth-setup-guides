'use strict';

// Evidence badges per guide section. Three honest tiers: "tested" only for
// work actually driven in the provider console (walkthrough data), "docs"
// when a fetched official page backs it, otherwise "uncertain".

function buildConfidence(guide, walkthrough = null) {
  const g = guide || {};
  const w = walkthrough || null;
  const getCov = (slotKey) => (g.coverage && g.coverage[slotKey]) || null;

  let registration, credentials;
  if (w && w.tested_scope && w.tested_scope.includes('app_registration')) {
    registration = { status: 'tested', label: 'Verified by Testing', note: `App registration tested ${w.tested_at || g.last_checked || ''}`.trim() };
  } else {
    const cov = getCov('create_app');
    registration = cov && cov.status === 'verified' && cov.url
      ? { status: 'docs', label: 'Backed by Official Docs', note: 'App creation process referenced in official documentation.' }
      : { status: 'uncertain', label: 'Uncertain / Unverified', note: 'App registration steps not verified by testing or a fetched official page.' };
  }

  if (w && w.tested_scope && w.tested_scope.includes('credential_issuance')) {
    credentials = { status: 'tested', label: 'Verified by Testing', note: `Credential issuance tested ${w.tested_at || g.last_checked || ''}`.trim() };
  } else {
    const cov = getCov('credentials');
    credentials = cov && cov.status === 'verified' && cov.url
      ? { status: 'docs', label: 'Backed by Official Docs', note: 'Credential issuance backed by official documentation source.' }
      : { status: 'uncertain', label: 'Uncertain / Unverified', note: 'Credential issuance details unverified by direct testing or docs.' };
  }

  const redCov = getCov('redirect_uri');
  const redirect_uri = redCov && redCov.status === 'verified' && redCov.url
    ? { status: 'docs', label: 'Backed by Official Docs', note: 'Redirect URI rules backed by official documentation.' }
    : { status: 'uncertain', label: 'Uncertain / Unverified', note: 'Redirect URI requirements not formally verified in fetched sources.' };

  const scopeCov = getCov('scopes');
  const scopes = scopeCov && scopeCov.status === 'verified' && scopeCov.url
    ? { status: 'docs', label: 'Backed by Official Docs', note: 'OAuth scope documentation backed by official source links.' }
    : { status: 'uncertain', label: 'Uncertain / Unverified', note: 'Scope configuration not confirmed by direct doc citations.' };

  const appCov = getCov('approval');
  const approval = appCov && appCov.status === 'verified' && appCov.url
    ? { status: 'docs', label: 'Backed by Official Docs', note: 'Approval requirement policy backed by official documentation.' }
    : { status: 'uncertain', label: 'Uncertain / Unverified', note: 'Approval policy is behind a portal wall or not documented.' };

  // Scoping rule: approval wait times are never "tested" - at best docs.
  const timeline = { status: 'uncertain', label: 'Uncertain / Unverified', note: 'Approval wait times are estimates or unverified behind login walls.' };

  return { registration, credentials, redirect_uri, scopes, approval, timeline };
}

// Per-step badge: a verified step is docs-backed (its source page was fetched
// and word-matched server-side); anything else is uncertain.
function buildStepConfidence(step, guideSources = []) {
  if (step.verified || step.source) {
    return { status: 'docs', label: 'Backed by Official Docs', sourceUrl: step.source || (guideSources[0] || {}).url || null };
  }
  return { status: 'uncertain', label: 'Uncertain / Unverified', sourceUrl: null };
}

module.exports = { buildConfidence, buildStepConfidence };
