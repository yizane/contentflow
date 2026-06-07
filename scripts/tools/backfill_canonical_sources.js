#!/usr/bin/env node
// backfill_canonical_sources.js — idempotently build source_canonical_items from existing source_items.
const my = require('../lib/mysql_lib');
const { canonicalizeUrl, canonicalUrlHash } = require('../lib/source_identity_lib');
const { contentFingerprint } = require('../lib/source_ingest_lib');
const { parseExtraJson, resolveSourceLane } = require('../lib/source_lanes_lib');
const runtime = require('../lib/workflow_runtime_lib');

function mysqlDateTime(value) {
  if (!value) return my.now();
  if (value instanceof Date) return runtime.mysqlDateTimeFromDate(value);
  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) return runtime.mysqlDateTimeFromDate(d);
  return String(value).slice(0, 23).replace('T', ' ');
}

async function main() {
  const stats = { ok: true, scanned: 0, canonicalInserted: 0, canonicalUpdated: 0, duplicatesCollapsed: 0 };
  try {
    const configRows = await my.query('SELECT name, category, priority, freshness, extra_json FROM config_sources');
    const configByName = new Map(configRows.map((r) => [r.name, { ...r, ...parseExtraJson(r.extra_json) }]));
    const rows = await my.query(`
      SELECT id, source_name, source_group, source_url, source_type, title, summary, raw_json,
             retrieved_at, created_at
      FROM source_items
      WHERE source_url IS NOT NULL AND source_url != ''
      ORDER BY COALESCE(retrieved_at, created_at), created_at
    `);
    stats.scanned = rows.length;

    const seenInRun = new Set();
    for (const row of rows) {
      const canonical_url = canonicalizeUrl(row.source_url);
      if (!canonical_url) continue;
      const hash = canonicalUrlHash(canonical_url);
      const sourceConfig = configByName.get(row.source_name) || {};
      const lane = resolveSourceLane({
        ...sourceConfig,
        name: row.source_name,
        group: row.source_group,
        type: row.source_type,
        category: sourceConfig.category || row.source_group,
        raw: my.asJson(row.raw_json),
      });
      const firstSeen = mysqlDateTime(row.retrieved_at || row.created_at || my.now());
      const fingerprint = contentFingerprint(row);
      const existing = (await my.query('SELECT source_item_id FROM source_canonical_items WHERE canonical_url_hash = ? LIMIT 1', [hash]))[0];
      if (existing) {
        await my.query(`
          UPDATE source_canonical_items
          SET first_seen_at = CASE
                WHEN CAST(first_seen_at AS CHAR) LIKE '0000-00-00%' THEN ?
                WHEN first_seen_at > ? THEN ?
                ELSE first_seen_at
              END,
              last_seen_at = GREATEST(last_seen_at, ?),
              seen_count = GREATEST(seen_count, 1),
              lane = CASE
                WHEN lane = 'policy' OR ? = 'policy' THEN 'policy'
                WHEN lane = 'news' OR ? = 'news' THEN 'news'
                ELSE 'knowledge'
              END,
              content_fingerprint = COALESCE(content_fingerprint, ?),
              updated_at = ?
          WHERE canonical_url_hash = ?
        `, [firstSeen, firstSeen, firstSeen, firstSeen, lane, lane, fingerprint, my.now(), hash]);
        stats.canonicalUpdated++;
        if (!seenInRun.has(hash)) seenInRun.add(hash);
        else stats.duplicatesCollapsed++;
        continue;
      }

      await my.insert('source_canonical_items', {
        canonical_url_hash: hash,
        canonical_url,
        source_item_id: row.id,
        first_seen_at: firstSeen,
        last_seen_at: firstSeen,
        seen_count: 1,
        source_count: 1,
        lane,
        usage_status: 'unused',
        times_in_prompt: 0,
        content_fingerprint: fingerprint,
        last_engine_run_id: null,
        last_observation_id: null,
        created_at: my.now(),
        updated_at: my.now(),
      });
      stats.canonicalInserted++;
      seenInRun.add(hash);
    }

    console.log(JSON.stringify(stats, null, 2));
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err.message, ...stats }, null, 2));
    process.exitCode = 1;
  } finally {
    await my.closePool();
  }
}

main();
