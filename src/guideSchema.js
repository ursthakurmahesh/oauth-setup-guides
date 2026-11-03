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
  if (!Array.isArray(guide.steps) || guide.steps.length === 0) {
    errors.push('steps must be a non-empty array');
  } else {
    guide.steps.forEach((step, i) => {
      if (!step || typeof step.title !== 'string' || step.title.trim() === '') {
        errors.push(`steps[${i}] missing title`);
      }
      if (step && typeof step.verified !== 'boolean') {
        errors.push(`steps[${i}].verified must be a boolean (true = checked against a live source)`);
      }
    });
  }
  for (const listField of ['nuances', 'agent_can_do', 'human_must_do']) {
    if (!Array.isArray(guide[listField])) errors.push(`${listField} must be an array`);
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
