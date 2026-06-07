// source_ingest_lib.js — source canonicalization + observation ingest.
const my = require('./mysql_lib');
const { canonicalizeUrl, canonicalUrlHash, sha256 } = require('./source_identity_lib');
const { resolveSourceLane, strongerLane } = require('./source_lanes_lib');

function sourceNameOf(item) {
  return item.sourceName || item.source_name || item.name || 'unknown_source';
}

function sourceGroupOf(item) {
  return item.sourceGroup || item.source_group || item.group || 'unknown_group';
}

function sourceCategoryOf(item) {
  return item.sourceCategory || item.source_category || item.category || null;
}

function itemUrlOf(item) {
  return item.url || item.source_url || '';
}

function contentFingerprint(item) {
  return sha256([
    item.title || '',
    item.summary || '',
    item.content_text || item.contentText || '',
  ].join('\n').trim());
}

function normalizeCollectedItem(item, now) {
  const source_url = itemUrlOf(item);
  const canonical_url = canonicalizeUrl(source_url);
  const canonical_url_hash = canonicalUrlHash(canonical_url);
  const source_lane = resolveSourceLane({
    ...item,
    name: sourceNameOf(item),
    category: sourceCategoryOf(item),
    lane: item.sourceLane || item.source_lane || item.lane,
  });
  return {
    source_url,
    canonical_url,
    canonical_url_hash,
    source_lane,
    source_name: sourceNameOf(item),
    source_group: sourceGroupOf(item),
    source_category: sourceCategoryOf(item),
    source_type: item.itemType || item.source_type || item.type || null,
    title: String(item.title || '').slice(0, 510),
    summary: item.summary || null,
    published_at: (item.publishedAt || item.published_at || item.as_of || '').slice(0, 64) || null,
    retrieved_at: now,
    fingerprint: contentFingerprint(item),
    raw: item,
  };
}

function planSourceIngest(items, existingByHash = new Map(), { now = '2026-06-06 00:00:00.000' } = {}) {
  const seen = new Map(existingByHash);
  const observations = [];
  const newSources = [];
  const seenSources = [];
  const ignored = [];

  for (const item of items || []) {
    const normalized = normalizeCollectedItem(item, now);
    if (!normalized.source_url || !normalized.canonical_url) {
      ignored.push({ item, reason: 'missing_url' });
      continue;
    }
    const existing = seen.get(normalized.canonical_url_hash);
    if (existing) {
      const status = existing.lane === 'policy' && existing.content_fingerprint && existing.content_fingerprint !== normalized.fingerprint
        ? 'reactivated_source'
        : 'seen_source';
      const observation = { ...normalized, source_item_id: existing.source_item_id, observation_status: status };
      observations.push(observation);
      seenSources.push(observation);
      seen.set(normalized.canonical_url_hash, { ...existing, lane: strongerLane(existing.lane, normalized.source_lane), content_fingerprint: normalized.fingerprint });
    } else {
      const source_item_id = `source_${String(newSources.length + 1).padStart(4, '0')}`;
      const observation = { ...normalized, source_item_id, observation_status: 'new_source' };
      observations.push(observation);
      newSources.push(observation);
      seen.set(normalized.canonical_url_hash, {
        canonical_url_hash: normalized.canonical_url_hash,
        source_item_id,
        lane: normalized.source_lane,
        content_fingerprint: normalized.fingerprint,
      });
    }
  }

  return { observations, newSources, seenSources, ignored };
}

async function insertObservation(row, { engineRunId, dailyKey, now, sourceItemId, status, duplicateReason = null }) {
  const observationId = my.makeId('sobs');
  await my.insert('source_observations', {
    id: observationId,
    engine_run_id: engineRunId || null,
    daily_key: dailyKey || null,
    source_item_id: sourceItemId || null,
    canonical_url_hash: row.canonical_url_hash,
    source_name: row.source_name,
    source_group: row.source_group,
    source_url: row.source_url,
    canonical_url: row.canonical_url,
    source_lane: row.source_lane,
    title: row.title,
    summary: row.summary,
    published_at: row.published_at,
    retrieved_at: now,
    observation_status: status,
    duplicate_reason: duplicateReason,
    raw_json: row.raw,
    created_at: now,
  });
  return observationId;
}

async function insertSourceItem(row, { engineRunId, now, trustOf }) {
  const sourceItemId = my.makeId('source');
  await my.insert('source_items', {
    id: sourceItemId,
    engine_run_id: engineRunId || null,
    source_name: row.source_name,
    source_group: row.source_group,
    source_url: row.source_url,
    source_type: row.source_type,
    source_trust: trustOf ? trustOf(row.source_category) : null,
    title: row.title,
    summary: row.summary,
    content_text: null,
    retrieved_at: now,
    as_of: row.published_at ? row.published_at.slice(0, 32) : null,
    raw_json: row.raw,
    created_at: now,
  });
  return sourceItemId;
}

async function upsertCanonical(row, { sourceItemId, observationId, engineRunId, now, existing = null }) {
  if (existing) {
    const promotedLane = strongerLane(existing.lane, row.source_lane);
    await my.query(`
      UPDATE source_canonical_items
      SET last_seen_at = ?,
          seen_count = seen_count + 1,
          lane = ?,
          last_engine_run_id = ?,
          last_observation_id = ?,
          updated_at = ?
      WHERE canonical_url_hash = ?
    `, [now, promotedLane, engineRunId || null, observationId || null, now, row.canonical_url_hash]);
    return promotedLane;
  }

  await my.query(`
    INSERT INTO source_canonical_items (
      canonical_url_hash, canonical_url, source_item_id, first_seen_at, last_seen_at,
      seen_count, source_count, lane, usage_status, times_in_prompt, content_fingerprint,
      last_engine_run_id, last_observation_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 1, 1, ?, 'unused', 0, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      last_seen_at = VALUES(last_seen_at),
      seen_count = seen_count + 1,
      lane = CASE
        WHEN lane = 'policy' OR VALUES(lane) = 'policy' THEN 'policy'
        WHEN lane = 'news' OR VALUES(lane) = 'news' THEN 'news'
        ELSE 'knowledge'
      END,
      last_engine_run_id = VALUES(last_engine_run_id),
      last_observation_id = VALUES(last_observation_id),
      updated_at = VALUES(updated_at)
  `, [
    row.canonical_url_hash, row.canonical_url, sourceItemId, now, now,
    row.source_lane, row.fingerprint, engineRunId || null, observationId || null, now, now,
  ]);
  return row.source_lane;
}

async function reactivatePolicySource(row, existing, { now }) {
  await my.update('source_canonical_items', {
    content_fingerprint: row.fingerprint,
    reactivated_at: now,
    updated_at: now,
  }, 'canonical_url_hash = ?', [row.canonical_url_hash]);

  await my.update('source_items', {
    title: row.title,
    summary: row.summary,
    retrieved_at: now,
    as_of: row.published_at ? row.published_at.slice(0, 32) : null,
    raw_json: row.raw,
  }, 'id = ?', [existing.source_item_id]);
}

async function ingestCollectedSources({ items, engineRunId = null, dailyKey = null, now = my.now(), trustOf = null } = {}) {
  const result = {
    observations: 0,
    insertedSources: 0,
    seenSources: 0,
    reactivatedSources: 0,
    ignored: 0,
    insertedRows: [],
    insertedBySource: {},
    observedBySource: {},
    warnings: [],
  };

  for (const item of items || []) {
    const row = normalizeCollectedItem(item, now);
    if (!row.source_url || !row.canonical_url) {
      result.ignored++;
      continue;
    }

    const existing = (await my.query('SELECT * FROM source_canonical_items WHERE canonical_url_hash = ? LIMIT 1', [row.canonical_url_hash]))[0];
    if (existing) {
      const isReactivated = strongerLane(existing.lane, row.source_lane) === 'policy'
        && existing.content_fingerprint
        && existing.content_fingerprint !== row.fingerprint;
      if (isReactivated) await reactivatePolicySource(row, existing, { now });
      const status = isReactivated ? 'reactivated_source' : 'seen_source';
      const observationId = await insertObservation(row, { engineRunId, dailyKey, now, sourceItemId: existing.source_item_id, status });
      await upsertCanonical(row, { sourceItemId: existing.source_item_id, observationId, engineRunId, now, existing });
      result.observations++;
      result.observedBySource[row.source_name] = (result.observedBySource[row.source_name] || 0) + 1;
      result.seenSources++;
      if (isReactivated) result.reactivatedSources++;
      continue;
    }

    const sourceItemId = await insertSourceItem(row, { engineRunId, now, trustOf });
    const observationId = await insertObservation(row, { engineRunId, dailyKey, now, sourceItemId, status: 'new_source' });
    await upsertCanonical(row, { sourceItemId, observationId, engineRunId, now });
    result.observations++;
    result.insertedSources++;
    result.observedBySource[row.source_name] = (result.observedBySource[row.source_name] || 0) + 1;
    result.insertedRows.push({
      id: sourceItemId,
      title: row.title,
      summary: row.summary,
      source_group: row.source_group,
      source_name: row.source_name,
    });
    result.insertedBySource[row.source_name] = (result.insertedBySource[row.source_name] || 0) + 1;
  }

  return result;
}

async function canonicalSourceIdsForUrls(urls) {
  const out = new Map();
  for (const url of urls || []) {
    const canonical_url_hash = canonicalUrlHash(url);
    const rows = await my.query('SELECT source_item_id FROM source_canonical_items WHERE canonical_url_hash = ? LIMIT 1', [canonical_url_hash]);
    if (rows[0]) out.set(url, rows[0].source_item_id);
  }
  return out;
}

module.exports = {
  normalizeCollectedItem,
  contentFingerprint,
  planSourceIngest,
  ingestCollectedSources,
  canonicalSourceIdsForUrls,
};
