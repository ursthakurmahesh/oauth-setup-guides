'use strict';

// A guide is the unit everything in this product produces and shares.
// It is deliberately JSON (not markdown) so every fact can carry its own
// source and verification status.

const DIFFICULTIES = ['easy', 'moderate', 'hard'];

const REQUIRED_STRING_FIELDS = ['slug', 'app', 'summary', 'last_checked'];

function validateGuide(guide) {
  const errors = [];
  if (guide === null || typeof guide !== 'object' || Array.isArray(guide)) {
    return ['guide must be an object'];
  }
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof guide[field] !== 'string' || guide[field].trim() === '') {
      errors.push(`missing or empty string field: ${field}`);
    }
  }
  if (guide.slug && !/^[a-z0-9][a-z0-9-]*$/.test(guide.slug)) {
    errors.push('slug must be lowercase letters, digits and hyphens');
  }
  if (guide.difficulty && !DIFFICULTIES.includes(guide.difficulty)) {
    errors.push(`difficulty must be one of ${DIFFICULTIES.join(', ')}`);
  }
  if (!guide.approval || typeof guide.approval !== 'object') {
    errors.push('missing approval object {required, typical_timeline, notes}');
  } else {
    if (typeof guide.approval.required !== 'boolean' && guide.approval.required !== 'conditional') {
      errors.push('approval.required must be true, false or "conditional"');
    }
    if (typeof guide.approval.typical_timeline !== 'string') {
      errors.push('approval.typical_timeline must be a string');
    }
  }
  for (const urlField of ['console_url', 'website']) {
    if (guide[urlField] != null && !(typeof guide[urlField] === 'string' && /^https?:\/\//.test(guide[urlField]))) {
      errors.push(`${urlField} must be an http(s) url when present`);
    }
  }
  if (!Array.isArray(guide.steps) || guide.steps.length === 0) {
    errors.push('steps must be a non-empty array');
  } else {
    guide.steps.forEach((step, i) => {
      if (!step || typeof step.title !== 'string' || step.title.trim() === '') {
        errors.push(`steps[${i}] missing title`);
      }
      if (step && step.source != null && !/^https?:\/\//.test(String(step.source))) {
        errors.push(`steps[${i}].source must be an http(s) url`);
      }
      if (step && typeof step.verified !== 'boolean') {
        errors.push(`steps[${i}].verified must be a boolean (true only means the step's source URL was fetched by the server during investigation - it is docs-backed, never console-tested)`);
      }
    });
  }
  for (const listField of ['nuances', 'agent_can_do', 'human_must_do']) {
    if (!Array.isArray(guide[listField])) errors.push(`${listField} must be an array`);
  }
  if (guide.testing !== undefined) {
    if (!guide.testing || typeof guide.testing.console_attempted !== 'boolean') {
      errors.push('testing.console_attempted must be a boolean when testing is present');
    }
  }
  if (!Array.isArray(guide.sources) || guide.sources.length === 0) {
    errors.push('sources must be a non-empty array of {title, url}');
  } else {
    guide.sources.forEach((s, i) => {
      if (!s || typeof s.url !== 'string' || !/^https?:\/\//.test(s.url)) {
        errors.push(`sources[${i}] needs an http(s) url`);
      }
    });
  }
  return errors;
}

module.exports = { validateGuide, DIFFICULTIES };
