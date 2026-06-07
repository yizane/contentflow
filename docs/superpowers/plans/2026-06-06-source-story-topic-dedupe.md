# Source Observation And Topic Dedupe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a lean v1 that explains repeated collection and repeated topic candidates without adding supplier-specific trace logic, without relying on `source_items.engine_run_id` for daily source scope, and without polluting Viewer counts with duplicate audit rows.

**Architecture:** Keep MySQL as the only runtime store. Add new append/audit tables for daily observations, canonical source identity, topic coverage signals, and blocked topic audit records. Do not add `story_clusters` in v1 and do not require model-generated per-source assessments; cross-channel same-news clustering moves to v2 via an AI `story_match` task if needed. Topic dedupe decisions are centralized in `topic_dedupe_lib` and reused by generation/selection.

**Paired Plan:** `2026-06-06-source-lanes-redesign.md` uses the same migration 011. Lane and knowledge-usage state live on `source_canonical_items`; v1 still does not alter `source_items`.

**Tech Stack:** Node.js CommonJS, MySQL migrations, existing provider abstraction, existing `node:test`.

---

## Scope

### v1 Implements

- Daily raw collection observations.
- Canonical URL hash with unique upsert for repeated source detection.
- Daily topic input from observations joined to canonical source rows.
- Mechanical topic signals from candidate `sourceUrls`.
- Central topic dedupe decisions.
- Duplicate audit outside `topic_candidates` for hard-shadowed topics.
- Existing deferred semantics preserved.

### v1 Does Not Implement

- `story_clusters`.
- Model `sourceAssessments`.
- Embeddings.
- Viewer UI changes.
- News lane article generation.
- OpenClaw-specific trajectory import.

### v2 Candidate Work

- AI `story_match` task for cross-channel same-news clustering.
- Optional low-cost source assessment batch for `news_only / low_value` reasons.
- News lane (`news_flash`) generation.

---

## Files

- Create: `db/mysql_migrations/011_source_observation_topic_dedupe.sql`
  New tables only; avoid `ALTER TABLE` on existing large tables in v1.
- Create: `scripts/lib/source_identity_lib.js`
  Canonical URL, SHA256 hash, title normalization, mixed Chinese/English Jaccard.
- Create: `scripts/lib/source_ingest_lib.js`
  Source observation + canonical source upsert.
- Create: `scripts/lib/topic_dedupe_lib.js`
  Single source of truth for topic duplicate/defer/shadow decisions.
- Create: `scripts/tools/backfill_canonical_sources.js`
  One-time backfill for existing `source_items` into `source_canonical_items`.
- Modify: `scripts/lib/pipeline_lib.js`
  Use source ingestion, daily observation scope, mechanical topic signals, central topic dedupe.
- Modify: `scripts/lib/topic_portfolio_lib.js`
  Remove/delegate duplicate similarity logic to `topic_dedupe_lib`; preserve deferred回池.
- Modify: `scripts/lib/production_policy_lib.js`
  Remove dead sqlite-era `dedupeCheck` export or mark private; thresholds come from policy.
- Modify: `config/production_policy.yaml`
  Add topic dedupe thresholds and source-scope quotas from the paired source-lanes plan.
- Modify: `scripts/engine_report.js`
  Add source observation and topic dedupe audit stats.
- Modify: `docs/09_web_integration_contract.md`
  Document new workflow-side tables and Viewer filtering expectations.
- Modify: `test/workflow_contract.test.js`
  Unit tests for source canonicalization, upsert planning, topic dedupe thresholds, and deferred SQL.

No Viewer-owned implementation files in this plan: do not edit `scripts/view_server.js`, `scripts/lib/ui_api_lib.js`, or `webpage/`.

---

## Data Model

### `source_canonical_items`

Canonical URL identity and source reuse map. This avoids altering `source_items` and makes upsert idempotent.

```sql
CREATE TABLE IF NOT EXISTS source_canonical_items (
  canonical_url_hash CHAR(64) PRIMARY KEY,
  canonical_url VARCHAR(1024) NOT NULL,
  source_item_id VARCHAR(64) NOT NULL,
  first_seen_at DATETIME(3) NOT NULL,
  last_seen_at DATETIME(3) NOT NULL,
  seen_count INT NOT NULL DEFAULT 1,
  source_count INT NOT NULL DEFAULT 1,
  lane VARCHAR(16) NOT NULL DEFAULT 'knowledge',
  usage_status VARCHAR(16) NOT NULL DEFAULT 'unused',
  used_at DATETIME(3),
  used_by_article_id VARCHAR(64),
  times_in_prompt INT NOT NULL DEFAULT 0,
  reactivated_at DATETIME(3),
  content_fingerprint CHAR(64),
  last_engine_run_id VARCHAR(64),
  last_observation_id VARCHAR(64),
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  INDEX idx_source_canonical_source_item (source_item_id),
  INDEX idx_source_canonical_last_seen (last_seen_at),
  INDEX idx_source_canonical_lane_usage (lane, usage_status),
  INDEX idx_source_canonical_reactivated (reactivated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

Lane rules are defined by the paired source-lanes plan. If later observations for the same canonical URL come from a stronger lane, promote by precedence `policy > news > knowledge`; never downgrade in v1.

### `source_observations`

Every valid raw collected item becomes one observation, even if the URL was already seen in the same run.

```sql
CREATE TABLE IF NOT EXISTS source_observations (
  id VARCHAR(64) PRIMARY KEY,
  engine_run_id VARCHAR(64),
  daily_key VARCHAR(10),
  source_item_id VARCHAR(64),
  canonical_url_hash CHAR(64),
  source_name VARCHAR(255),
  source_group VARCHAR(128),
  source_url VARCHAR(1024),
  canonical_url VARCHAR(1024),
  source_lane VARCHAR(16),
  title VARCHAR(512),
  summary TEXT,
  published_at VARCHAR(64),
  retrieved_at DATETIME(3) NOT NULL,
  observation_status VARCHAR(64) NOT NULL, -- new_source | seen_source | reactivated_source | ignored
  duplicate_reason TEXT,
  raw_json JSON,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_source_observations_run (engine_run_id),
  INDEX idx_source_observations_daily (daily_key),
  INDEX idx_source_observations_hash (canonical_url_hash),
  INDEX idx_source_observations_source_item (source_item_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

### `topic_signals`

Mechanical coverage table. v1 does not ask the model to assess every source.

```sql
CREATE TABLE IF NOT EXISTS topic_signals (
  id VARCHAR(64) PRIMARY KEY,
  engine_run_id VARCHAR(64),
  source_observation_id VARCHAR(64),
  source_item_id VARCHAR(64),
  topic_candidate_id VARCHAR(64),
  signal_topic VARCHAR(512),
  status VARCHAR(64) NOT NULL,
  -- merged_into_candidate | not_selected_by_model | blocked_duplicate
  score INT,
  reason TEXT,
  raw_json JSON,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_topic_signals_run (engine_run_id),
  INDEX idx_topic_signals_observation (source_observation_id),
  INDEX idx_topic_signals_source_item (source_item_id),
  INDEX idx_topic_signals_candidate (topic_candidate_id),
  INDEX idx_topic_signals_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

### `topic_dedupe_records`

Audit table for generated candidate-like outputs that are blocked or deferred by dedupe logic. Hard-shadowed duplicates are recorded here and not inserted into `topic_candidates`, so Viewer candidate counts stay clean.

```sql
CREATE TABLE IF NOT EXISTS topic_dedupe_records (
  id VARCHAR(64) PRIMARY KEY,
  engine_run_id VARCHAR(64),
  topic_candidate_id VARCHAR(64),
  duplicate_of_topic_candidate_id VARCHAR(64),
  candidate_topic VARCHAR(512) NOT NULL,
  normalized_topic VARCHAR(512),
  primary_keyword VARCHAR(255),
  decision VARCHAR(64) NOT NULL,
  -- unique_inserted | deferred_duplicate | shadow_duplicate | deferred_keyword
  similarity DECIMAL(5,4),
  reason TEXT,
  raw_candidate_json JSON,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_topic_dedupe_run (engine_run_id),
  INDEX idx_topic_dedupe_decision (decision),
  INDEX idx_topic_dedupe_kw (primary_keyword),
  INDEX idx_topic_dedupe_candidate (topic_candidate_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

## Policy

Add thresholds to `config/production_policy.yaml`:

```yaml
topic_dedupe:
  shadow_similarity_threshold: 0.75
  defer_similarity_threshold: 0.55
  penalty_similarity_threshold: 0.35
  duplicate_defer_days: 14

source_scope:
  news_limit: 25
  news_window_hours: 72
  policy_limit: 15
  policy_window_hours: 168
  knowledge_limit: 40
  knowledge_pool_limit: 120
  knowledge_soft_expire_days: 90
```

Rules:

- Exact normalized topic match: `shadow_duplicate`.
- Similarity `>= shadow_similarity_threshold`: `shadow_duplicate`, do not insert `topic_candidates`.
- Similarity `>= defer_similarity_threshold` and `< shadow_similarity_threshold`: insert as existing `status='deferred'`, `selection_status='skipped_duplicate'`, `deferred_until = now + duplicate_defer_days`.
- Keyword throttle remains article-based, matching current behavior: count recent `articles.primary_keyword`, not candidate count.
- Dead sqlite-era `production_policy_lib.dedupeCheck` must not remain a competing decision path.

---

## Task 1: Migration 011

**Files:**
- Create: `db/mysql_migrations/011_source_observation_topic_dedupe.sql`
- Modify: `test/workflow_contract.test.js`

- [ ] **Step 1: Create migration**

Create only new tables from the Data Model section. Do not alter `source_items` or `topic_candidates` in v1.

- [ ] **Step 2: Add migration smoke test**

```js
test('migration 011 defines observation and dedupe audit tables', () => {
  const fs = require('node:fs');
  const p = path.join(__dirname, '..', 'db', 'mysql_migrations', '011_source_observation_topic_dedupe.sql');
  const sql = fs.readFileSync(p, 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS source_canonical_items/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS source_observations/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS topic_signals/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS topic_dedupe_records/);
  assert.doesNotMatch(sql, /ALTER TABLE source_items/);
  assert.doesNotMatch(sql, /ALTER TABLE topic_candidates/);
});
```

- [ ] **Step 3: Run tests**

Run: `npm test`

Expected: all tests pass.

---

## Task 2: Source Identity

**Files:**
- Create: `scripts/lib/source_identity_lib.js`
- Modify: `test/workflow_contract.test.js`

- [ ] **Step 1: Implement helper exports**

```js
function canonicalizeUrl(input) {}
function sha256(input) {}
function canonicalUrlHash(input) {}
function normalizeTitle(input) {}
function tokenizeMixed(text) {}
function jaccard(a, b) {}
function normalizedTopic(text) {}
module.exports = { canonicalizeUrl, sha256, canonicalUrlHash, normalizeTitle, tokenizeMixed, jaccard, normalizedTopic };
```

URL rules:

- lower-case protocol and host;
- strip hash;
- remove `utm_*`, `fbclid`, `gclid`, `mc_cid`, `mc_eid`;
- sort remaining query params;
- remove trailing slash except domain root.

- [ ] **Step 2: Add unit tests**

```js
test('canonicalizeUrl removes tracking params and hashes stable identity', () => {
  const id = require('../scripts/lib/source_identity_lib');
  const url = id.canonicalizeUrl('HTTPS://Example.com/Post/?utm_source=x&id=1#top');
  assert.equal(url, 'https://example.com/Post/?id=1');
  assert.match(id.canonicalUrlHash(url), /^[a-f0-9]{64}$/);
});

test('mixed jaccard catches similar Chinese topic titles', () => {
  const id = require('../scripts/lib/source_identity_lib');
  const sim = id.jaccard(
    '让 AI 引用我的产品页面：亚马逊商品页要补哪些可抽取信息',
    '让 AI 引用我的产品页面：亚马逊 Listing 需要补齐哪些可抽取信息'
  );
  assert.ok(sim >= 0.55, `expected similar titles, got ${sim}`);
});
```

---

## Task 3: Source Ingestion

**Files:**
- Create: `scripts/lib/source_ingest_lib.js`
- Modify: `scripts/lib/pipeline_lib.js`
- Modify: `test/workflow_contract.test.js`

- [ ] **Step 1: Implement source ingest API**

```js
async function ingestCollectedSources({ items, engineRunId, dailyKey, now, trustOf }) {}
module.exports = { ingestCollectedSources, planSourceIngest };
```

Return shape:

```js
{
  observations,
  insertedSources,
  seenSources,
  ignored,
  insertedRows,
  insertedBySource,
  warnings
}
```

Behavior:

- For every collected item with a URL, compute `canonical_url`, `canonical_url_hash`, `source_lane`,
  and a stable `content_fingerprint` from title + summary/body excerpt.
- Try `SELECT * FROM source_canonical_items WHERE canonical_url_hash = ?`.
- If existing:
  - update `last_seen_at`, `seen_count = seen_count + 1`, `last_engine_run_id`, `last_observation_id`;
  - promote `lane` only by source-lanes precedence `policy > news > knowledge`;
  - if `lane='policy'` and `content_fingerprint` changed:
    - update `source_canonical_items.content_fingerprint` and `reactivated_at`;
    - update the canonical `source_items` row's mutable content fields used by prompts
      (`title`, `summary`, `retrieved_at` where columns exist);
    - insert `source_observations` with `observation_status='reactivated_source'`;
  - otherwise insert `source_observations` with `observation_status='seen_source'`;
  - do not insert a new `source_items` row.
- If new:
  - insert a new `source_items` row;
  - insert `source_canonical_items` with `lane`, `content_fingerprint`, and `usage_status='unused'`;
  - insert `source_observations` with `observation_status='new_source'` and `source_lane`;
  - include row in `insertedRows` for classification.

Use `INSERT ... ON DUPLICATE KEY UPDATE` for `source_canonical_items` so reruns and parallel collection do not create duplicates.

- [ ] **Step 2: Replace collection insert block**

In `collectSources`, replace URL-only historical duplicate logic with:

```js
const { ingestCollectedSources } = require('./source_ingest_lib');
const runRows = engineRunId ? await my.query('SELECT daily_key FROM engine_runs WHERE id = ? LIMIT 1', [engineRunId]) : [];
const dailyKey = process.env.ENGINE_DAILY_KEY || (runRows[0] && runRows[0].daily_key) || null;
const ingest = await ingestCollectedSources({ items, engineRunId, dailyKey, now: my.now(), trustOf });
summary.total = ingest.observations;
summary.inserted = ingest.insertedSources;
summary.duplicatesHistorical = ingest.seenSources;
summary.ignored = ingest.ignored;
const insertedRows = ingest.insertedRows;
const insertedBySource = ingest.insertedBySource;
```

Do not derive `dailyKey` from `engineRunId` except in test fixtures.

- [ ] **Step 3: Add pure ingest tests**

Use `planSourceIngest` for deterministic tests without MySQL:

```js
test('source ingest keeps two observations for same canonical url', () => {
  const { planSourceIngest } = require('../scripts/lib/source_ingest_lib');
  const result = planSourceIngest([
    { title: 'A', url: 'https://example.com/post?utm_source=x', sourceName: 'one', sourceGroup: 'g' },
    { title: 'A copy', url: 'https://example.com/post', sourceName: 'two', sourceGroup: 'g' },
  ], new Map());
  assert.equal(result.observations.length, 2);
  assert.equal(result.newSources.length, 1);
  assert.equal(result.seenSources.length, 1);
});
```

---

## Task 4: Backfill Existing Canonical Sources

**Files:**
- Create: `scripts/tools/backfill_canonical_sources.js`
- Modify: `package.json`

- [ ] **Step 1: Add CLI**

Script behavior:

- Read `source_items` where `source_url IS NOT NULL`.
- Canonicalize URL with `source_identity_lib`.
- Upsert into `source_canonical_items`.
- Use the earliest `created_at/retrieved_at` row as canonical `source_item_id` for duplicate hashes.
- Print JSON:

```json
{
  "ok": true,
  "scanned": 227,
  "canonicalInserted": 180,
  "canonicalUpdated": 47,
  "duplicatesCollapsed": 47
}
```

- [ ] **Step 2: Add npm script**

```json
"sources:backfill-canonical": "node scripts/tools/backfill_canonical_sources.js"
```

- [ ] **Step 3: Verification**

Run:

```bash
npm run db:migrate
npm run sources:backfill-canonical
```

Expected: command is idempotent; second run does not increase canonical row count.

---

## Task 5: Daily Topic Source Scope And Signals

**Files:**
- Modify: `scripts/lib/prompt_lib.js`
- Modify: `scripts/lib/pipeline_lib.js`
- Modify: `test/workflow_contract.test.js`

- [ ] **Step 1: Query daily source scope from observations**

For `generateTopics({ engineRunId })`, replace direct `source_items WHERE engine_run_id = ?` with:

```sql
SELECT si.id, si.source_group, si.source_name, si.source_url, si.title, si.summary,
       si.content_type, si.business_category,
       sci.lane, sci.first_seen_at, sci.usage_status, sci.times_in_prompt,
       COUNT(so.id) AS observation_count,
       JSON_ARRAYAGG(so.id) AS observation_ids_json
FROM source_observations so
JOIN source_canonical_items sci ON sci.canonical_url_hash = so.canonical_url_hash
JOIN source_items si ON si.id = sci.source_item_id
WHERE so.engine_run_id = ?
GROUP BY si.id, si.source_group, si.source_name, si.source_url, si.title, si.summary,
         si.content_type, si.business_category,
         sci.lane, sci.first_seen_at, sci.usage_status, sci.times_in_prompt
ORDER BY MAX(so.created_at) DESC
LIMIT 80
```

This dedupes prompt input by canonical source while preserving observation IDs for signals.
When the paired source-lanes plan is implemented, replace the single `LIMIT 80` query with its
policy-driven `source_scope` quotas (`news:25`, `policy:15`, `knowledge:40`) over the same
`source_observations` + `source_canonical_items` join. Knowledge rows may come from the canonical
material pool even when they were not observed in the current run.

- [ ] **Step 2: Prompt source IDs stay simple**

Use row numbers plus source item IDs:

```js
`${n + 1}. sourceNo: ${n + 1}; sourceId: ${i.id}`
```

Do not add `sourceAssessments` to schema in v1.

- [ ] **Step 3: Mechanical topic signals**

After candidates are parsed:

- Map candidate `sourceUrls` to canonical `source_items.id` through `source_canonical_items`.
- For matched observation IDs, insert `topic_signals.status='merged_into_candidate'`.
- For observations not matched by any candidate, insert `topic_signals.status='not_selected_by_model'`.
- If a candidate is hard-shadowed by dedupe, insert `topic_signals.status='blocked_duplicate'` for its matched observations.

`generateTopics` return summary adds:

```js
topicSignals: {
  mergedIntoCandidate,
  notSelectedByModel,
  blockedDuplicate
}
```

---

## Task 6: Central Topic Dedupe

**Files:**
- Create: `scripts/lib/topic_dedupe_lib.js`
- Modify: `scripts/lib/pipeline_lib.js`
- Modify: `scripts/lib/topic_portfolio_lib.js`
- Modify: `scripts/lib/production_policy_lib.js`
- Modify: `config/production_policy.yaml`
- Modify: `test/workflow_contract.test.js`

- [ ] **Step 1: Implement decision helper**

```js
function decideTopicDedupe(candidate, recentTopics, policy) {}
function duplicateDeferUntil(now) {}
module.exports = { decideTopicDedupe, duplicateDeferUntil };
```

Return shape:

```js
{
  decision: 'unique' | 'shadow_duplicate' | 'deferred_duplicate' | 'deferred_keyword',
  duplicateOfTopicCandidateId: null,
  similarity: 0,
  reason: null
}
```

Policy:

- exact normalized match -> `shadow_duplicate`;
- similarity >= `topic_dedupe.shadow_similarity_threshold` -> `shadow_duplicate`;
- similarity >= `topic_dedupe.defer_similarity_threshold` -> `deferred_duplicate`;
- keyword throttle counts `articles`, not candidate rows.

- [ ] **Step 2: Generation uses the helper**

In `generateTopics`:

- Remove the existing inline `selectionStatus = skipped_duplicate` Jaccard block.
- For each parsed candidate, call `decideTopicDedupe`.
- If `shadow_duplicate`:
  - insert `topic_dedupe_records`;
  - do not insert `topic_candidates`.
- If `deferred_duplicate`:
  - insert `topic_candidates` with existing columns:

```js
status: 'deferred',
selection_status: 'skipped_duplicate',
selection_skip_reason: decision.reason,
deferred_until: duplicateDeferUntil(my.now())
```

  - insert `topic_dedupe_records` with `decision='deferred_duplicate'`.
- If `deferred_keyword`:
  - keep existing article-based keyword throttle semantics;
  - insert `status='deferred'`, `selection_status='skipped_recent_keyword'`;
  - insert `topic_dedupe_records`.
- If `unique`:
  - insert normal `topic_candidates`;
  - insert `topic_dedupe_records` with `decision='unique_inserted'`.

- [ ] **Step 3: Portfolio uses the same helper**

In `topic_portfolio_lib.js`:

- Remove local high-similarity hard-defer logic from `calculateSelectionScore`.
- Use `topic_dedupe_lib` for legacy candidates that have no dedupe audit.
- Preserve existing deferred回池 SQL:

```sql
WHERE (
  status IN ('candidate', 'selected')
  OR (status = 'deferred' AND deferred_until IS NOT NULL AND deferred_until <= ?)
)
```

Do not add `dedupe_status` SQL because v1 does not add that column. This avoids permanently stranding existing deferred candidates.

- [ ] **Step 4: Remove dead sqlite-era dedupe path**

In `production_policy_lib.js`, remove `dedupeCheck(db, candidate, policy)` from exports. If tests or code still require it, replace with `topic_dedupe_lib`.

- [ ] **Step 5: Tests**

```js
test('topic dedupe shadows only exact or very high similarity duplicates', () => {
  const { decideTopicDedupe } = require('../scripts/lib/topic_dedupe_lib');
  const policy = { topic_dedupe: { shadow_similarity_threshold: 0.75, defer_similarity_threshold: 0.55 } };
  const d = decideTopicDedupe(
    { topic: '让 AI 引用我的产品页面：亚马逊 Listing 需要补齐哪些可抽取信息', primaryKeyword: '让 AI 引用我的产品页面' },
    [{ id: 'old', topic: '让 AI 引用我的产品页面：亚马逊商品页要补哪些可抽取信息', primary_keyword: '让 AI 引用我的产品页面' }],
    policy
  );
  assert.equal(d.decision, 'deferred_duplicate');
});

test('topic dedupe shadows exact normalized duplicates', () => {
  const { decideTopicDedupe } = require('../scripts/lib/topic_dedupe_lib');
  const policy = { topic_dedupe: { shadow_similarity_threshold: 0.75, defer_similarity_threshold: 0.55 } };
  const d = decideTopicDedupe(
    { topic: 'ACoS 太高怎么降：关键词分层 SOP', primaryKeyword: 'ACoS 太高怎么降' },
    [{ id: 'old', topic: 'ACoS 太高怎么降：关键词分层 SOP', primary_keyword: 'ACoS 太高怎么降' }],
    policy
  );
  assert.equal(d.decision, 'shadow_duplicate');
});
```

---

## Task 7: Report And Contract

**Files:**
- Modify: `scripts/engine_report.js`
- Modify: `docs/09_web_integration_contract.md`
- Modify: `test/workflow_contract.test.js`

- [ ] **Step 1: Add report summary**

Add:

```js
sourceObservationCoverage: {
  observations,
  newSources,
  seenSources,
  ignored,
  canonicalSourcesSeen,
  topicSignalsByStatus,
  topicDedupeByDecision
},
sourceLanes: {
  news: { collected, fresh72h, inPrompt },
  policy: { collected, fresh7d, inPrompt, reactivated },
  knowledge: { total, unused, used, softExpired, inPromptToday, oldestUnusedDays }
}
```

- [ ] **Step 2: Update integration contract**

Document:

- `source_observations` is the daily source-count truth.
- `source_items` is canonical material and may have first-seen `engine_run_id`.
- `source_canonical_items` owns canonical URL identity, lane, and knowledge usage state.
- `topic_dedupe_records.shadow_duplicate` rows are audit-only and not Viewer article candidates.
- `topic_candidates.status='deferred'` continues to mean temporarily not selectable.

No Viewer code changes in this plan.

- [ ] **Step 3: Verification commands**

Run:

```bash
npm run db:migrate
npm run sources:backfill-canonical
npm test
ENGINE_RUN_ID=engine_20260602_manual_sources ENGINE_NOW=2026-06-02T09:20:00+08:00 npm run topics:generate
npm run jobs:create -- --limit 5 --dry-run --show-portfolio-debug
```

Expected:

- `source_observations` has one row per collected raw item with valid URL.
- Same canonical URL does not create multiple `source_items`.
- `topic_signals` count is at least same-run observation count after `topics:generate`.
- Exact/high duplicates are in `topic_dedupe_records` and absent from `topic_candidates`.
- Mid-similarity duplicates are `topic_candidates.status='deferred'` and can return after `deferred_until`.
- `jobs:create` does not select duplicate shadows because they are not in `topic_candidates`.

---

## Acceptance Criteria

- Re-running collection over the same URLs increments canonical seen counts and writes new observations.
- Daily topic generation uses same-run observations, not first-seen `source_items.engine_run_id`.
- Topic candidates remain enough for daily production while exact/high duplicates are blocked.
- Existing deferred candidates still回池; no `dedupe_status` column is required.
- `source_item_ids_json` remains populated for inserted unique/deferred candidates.
- `topic_signals` explains source coverage mechanically.
- `npm test` passes.
- `docs/09_web_integration_contract.md` documents the workflow-side data shape.
