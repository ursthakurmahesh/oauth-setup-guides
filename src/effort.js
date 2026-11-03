'use strict';

// Hands-on effort estimate for a guide. The brief asks for the likely time and
// effort of a setup; provider docs almost never publish setup minutes, so this
// is a deterministic estimate from the fixed difficulty rubric and the step
// count - always labeled as an estimate, never presented as measured.

const RANGES = {
  easy: [10, 20],
  moderate: [30, 60],
  hard: [90, 180],
};

function fmtMinutes(m) {
  if (m < 90) return `${m} minutes`;
  const hours = m / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} hours`;
}

function estimateEffort(guide) {
  const steps = Array.isArray(guide.steps) ? guide.steps.length : 0;
  let [lo, hi] = RANGES[guide.difficulty] || RANGES.moderate;
  if (steps >= 7) { lo = Math.round(lo * 1.5); hi = Math.round(hi * 1.5); }
  const range = lo < 90 && hi < 90 ? `${lo}-${hi} minutes` : `${fmtMinutes(lo)}-${fmtMinutes(hi)}`;
  return {
    range,
    text: `roughly ${range} of hands-on setup (agent estimate from the difficulty rubric and ${steps} documented steps - not measured)`,
  };
}

module.exports = { estimateEffort };
