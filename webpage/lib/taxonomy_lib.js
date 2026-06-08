// taxonomy_lib.js — Viewer-side taxonomy labels.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function parseTaxonomyYaml(text) {
  const out = { version: 1, content_types: {}, business_categories: {}, topic_clusters: {} };
  let section = null;
  let entry = null;
  const unquote = (s) => s.replace(/^["']|["']$/g, '');
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      const match = t.match(/^([\w]+)\s*:\s*(.*)$/);
      if (!match) continue;
      if (match[2]) {
        out[match[1]] = Number.isNaN(Number(match[2])) ? unquote(match[2]) : Number(match[2]);
        section = null;
      } else {
        section = match[1];
        if (!out[section]) out[section] = {};
      }
      entry = null;
      continue;
    }
    if (!section) continue;
    if (indent === 2) {
      const match = t.match(/^([\w]+)\s*:\s*$/);
      if (match) {
        entry = {};
        out[section][match[1]] = entry;
      }
      continue;
    }
    if (indent >= 4 && entry) {
      const match = t.match(/^([\w]+)\s*:\s*(.+)$/);
      if (match) entry[match[1]] = unquote(match[2].trim());
    }
  }
  return out;
}

let cached = null;
function loadTaxonomy() {
  if (cached) return cached;
  const file = path.join(ROOT, 'config', 'content_taxonomy.yaml');
  if (!fs.existsSync(file)) throw new Error('config/content_taxonomy.yaml 缺失');
  cached = parseTaxonomyYaml(fs.readFileSync(file, 'utf8'));
  return cached;
}

function labelOf(kind, key) {
  if (!key) return null;
  const taxonomy = loadTaxonomy();
  const map = { content_type: taxonomy.content_types, business_category: taxonomy.business_categories, topic_cluster: taxonomy.topic_clusters }[kind];
  return (map && map[key] && map[key].label_zh) || key;
}

module.exports = { loadTaxonomy, parseTaxonomyYaml, labelOf };
