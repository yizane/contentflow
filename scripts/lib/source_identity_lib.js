// source_identity_lib.js — canonical URL identity + mixed Chinese/English similarity helpers.
const crypto = require('crypto');

const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'mc_cid', 'mc_eid']);

function sha256(input) {
  return crypto.createHash('sha256').update(String(input || '')).digest('hex');
}

function canonicalizeUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  let u;
  try {
    u = new URL(raw);
  } catch (_) {
    try {
      u = new URL(`https://${raw}`);
    } catch (_) {
      return raw.replace(/#.*$/, '').replace(/\/+$/, '');
    }
  }

  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase();
  u.hash = '';

  const params = [];
  for (const [k, v] of u.searchParams.entries()) {
    const lk = k.toLowerCase();
    if (lk.startsWith('utm_') || TRACKING_PARAMS.has(lk)) continue;
    params.push([k, v]);
  }
  params.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  u.search = '';
  for (const [k, v] of params) u.searchParams.append(k, v);

  if (u.pathname !== '/') u.pathname = u.pathname.replace(/\/+$/, '');
  return u.toString();
}

function canonicalUrlHash(input) {
  return sha256(canonicalizeUrl(input));
}

function normalizeTitle(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^\p{Script=Han}a-z0-9]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizedTopic(input) {
  return normalizeTitle(input).replace(/\s+/g, '').slice(0, 512);
}

function tokenizeMixed(text) {
  const tokens = new Set();
  const norm = normalizeTitle(text);
  for (const part of norm.split(/\s+/)) {
    if (!part) continue;
    const latin = part.match(/[a-z0-9]+/g) || [];
    for (const t of latin) tokens.add(t);

    const hanRuns = part.match(/\p{Script=Han}+/gu) || [];
    for (const run of hanRuns) {
      if (run.length === 1) tokens.add(run);
      else {
        for (let i = 0; i < run.length - 1; i++) tokens.add(run.slice(i, i + 2));
      }
    }
  }
  return tokens;
}

function jaccard(a, b) {
  const ta = tokenizeMixed(a);
  const tb = tokenizeMixed(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection++;
  return intersection / (ta.size + tb.size - intersection);
}

module.exports = {
  canonicalizeUrl,
  sha256,
  canonicalUrlHash,
  normalizeTitle,
  tokenizeMixed,
  jaccard,
  normalizedTopic,
};
