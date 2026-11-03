'use strict';

// File-backed guide store: the pre-built library in data/guides plus
// agent-generated guides persisted to data/generated so they stay shareable.

const fs = require('fs');
const path = require('path');
const { validateGuide } = require('./guideSchema');

const GUIDES_DIR = path.join(__dirname, '..', 'data', 'guides');
const GENERATED_DIR = path.join(__dirname, '..', 'data', 'generated');

function readDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      } catch (err) {
        console.error(`skipping unreadable guide ${f}: ${err.message}`);
        return null;
      }
    })
    .filter(Boolean);
}

function listGuides() {
  const library = readDir(GUIDES_DIR).map((g) => ({ ...g, origin: 'library' }));
  const generated = readDir(GENERATED_DIR).map((g) => ({ ...g, origin: 'generated' }));
  return [...library, ...generated];
}

function getGuide(slug) {
  return listGuides().find((g) => g.slug === slug) || null;
}

function searchGuides(term) {
  const q = String(term || '').toLowerCase().trim();
  const all = listGuides();
  if (!q) return all;
  return all.filter((g) =>
    [g.app, g.slug, g.summary, g.website].filter(Boolean).some((v) => v.toLowerCase().includes(q)));
}

function saveGenerated(guide) {
  const errors = validateGuide(guide);
  if (errors.length) throw new Error(`generated guide failed validation: ${errors.join('; ')}`);
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  fs.writeFileSync(path.join(GENERATED_DIR, `${guide.slug}.json`), JSON.stringify(guide, null, 2));
  return guide;
}

module.exports = { listGuides, getGuide, searchGuides, saveGenerated };
