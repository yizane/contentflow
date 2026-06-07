const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function envWithoutMysql() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('MYSQL_')) delete env[k];
  }
  return env;
}

test('ENGINE_NOW controls MySQL timestamps and run ids', () => {
  const my = require('../scripts/lib/mysql_lib');
  const oldEngineNow = process.env.ENGINE_NOW;
  process.env.ENGINE_NOW = '2026-06-01';
  try {
    assert.equal(my.now(), '2026-06-01 00:00:00.000');
    assert.match(my.makeRunId('engine'), /^engine_20260601_000000_[0-9a-f]{4}$/);
  } finally {
    if (oldEngineNow === undefined) delete process.env.ENGINE_NOW;
    else process.env.ENGINE_NOW = oldEngineNow;
  }
});

test('daily as-of date drives daily key, ENGINE_NOW, and target-ready invocation', () => {
  const { parseDailyArgs, buildDailyBatchInvocation } = require('../scripts/lib/workflow_runtime_lib');
  const args = parseDailyArgs(['node', 'engine_daily.js', '--as-of-date', '2026-06-01', '--mode', 'retry']);
  assert.equal(args.dailyKey, '2026-06-01');
  assert.equal(args.engineNow, '2026-06-01T00:00:00.000Z');

  const invocation = buildDailyBatchInvocation({
    args,
    runId: 'engine_20260601_000000_abcd',
    isActive: 1,
    scriptPath: '/repo/scripts/engine_batch.js',
  });
  assert.equal(invocation.env.ENGINE_NOW, '2026-06-01T00:00:00.000Z');
  assert.deepEqual(invocation.argv.slice(0, 3), ['node', '/repo/scripts/engine_batch.js', '--limit']);
  assert.ok(invocation.argv.includes('--target-ready'));
  assert.ok(invocation.argv.includes('5'));
  assert.ok(invocation.argv.includes('--retry'));
});

test('batch dry-run plan is target-driven and retry-safe', () => {
  const { parseBatchArgs, buildBatchDryRunPlan } = require('../scripts/lib/workflow_runtime_lib');
  const args = parseBatchArgs(['node', 'engine_batch.js', '--retry', '--target-ready', '5', '--max-attempts', '12']);

  const plan = buildBatchDryRunPlan(args, { reusableJobs: 3 });
  assert.equal(plan.targetReady, 5);
  assert.equal(plan.maxAttempts, 12);
  assert.equal(plan.retryReusableJobs, 3);
  assert.equal(plan.steps[0], 'retry:check-reusable-jobs');
  assert.ok(!plan.steps.includes('sources:collect'));
  assert.ok(!plan.steps.includes('topics:generate'));
  assert.ok(plan.steps.includes('channels:generate --status ready_for_review --missing-only'));
});

test('quality scoring failure blocks ready_for_review', () => {
  const { decideReadyGate } = require('../scripts/lib/workflow_runtime_lib');
  assert.deepEqual(decideReadyGate({ intendedStatus: 'ready_for_review', score: null, scoreOk: false }), {
    status: 'needs_quality_revision',
    gated: true,
    score: null,
    reason: '文章质量主评分失败，不能进入终审',
  });
});

test('channels default only processes ready_for_review articles', () => {
  const { defaultChannelStatuses } = require('../scripts/pipeline/channels_generate');
  assert.deepEqual(defaultChannelStatuses(), ['ready_for_review']);
});

test('engine batch dry-run works without MySQL env', () => {
  const script = path.join(__dirname, '..', 'scripts', 'engine_batch.js');
  const r = spawnSync(process.execPath, [script, '--dry-run', '--as-of-date', '2026-06-01', '--target-ready', '5'], {
    cwd: path.join(__dirname, '..'),
    env: envWithoutMysql(),
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /"engineNow": "2026-06-01T00:00:00.000Z"/);
  assert.match(r.stdout, /"targetReady": 5/);
});

test('engine daily dry-run works without MySQL env and passes batch target', () => {
  const script = path.join(__dirname, '..', 'scripts', 'engine_daily.js');
  const r = spawnSync(process.execPath, [script, '--dry-run', '--as-of-date', '2026-06-01'], {
    cwd: path.join(__dirname, '..'),
    env: envWithoutMysql(),
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /"dailyKey": "2026-06-01"/);
  assert.match(r.stdout, /"--target-ready"/);
  assert.match(r.stdout, /"5"/);
});

test('migration 011 defines observation and dedupe audit tables without altering existing large tables', () => {
  const p = path.join(__dirname, '..', 'db', 'mysql_migrations', '011_source_observation_topic_dedupe.sql');
  const sql = fs.readFileSync(p, 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS source_canonical_items/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS source_observations/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS topic_signals/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS topic_dedupe_records/);
  assert.match(sql, /canonical_url_hash CHAR\(64\) PRIMARY KEY/);
  assert.doesNotMatch(sql, /ALTER TABLE source_items/);
  assert.doesNotMatch(sql, /ALTER TABLE topic_candidates/);
});

test('canonicalizeUrl removes tracking params and hashes stable identity', () => {
  const id = require('../scripts/lib/source_identity_lib');
  const url = id.canonicalizeUrl('HTTPS://Example.com/Post/?utm_source=x&id=1&gclid=y#top');
  assert.equal(url, 'https://example.com/Post?id=1');
  assert.equal(id.canonicalUrlHash(url), id.canonicalUrlHash('https://example.com/Post?id=1&utm_campaign=nope'));
});

test('mixed jaccard catches similar Chinese topic titles', () => {
  const id = require('../scripts/lib/source_identity_lib');
  const sim = id.jaccard(
    '让 AI 引用我的产品页面：亚马逊商品页要补哪些可抽取信息',
    '让 AI 引用我的产品页面：亚马逊 Listing 需要补齐哪些可抽取信息'
  );
  assert.ok(sim >= 0.55, `expected similar titles, got ${sim}`);
});

test('source ingest keeps observations while collapsing canonical url', () => {
  const { planSourceIngest } = require('../scripts/lib/source_ingest_lib');
  const result = planSourceIngest([
    { title: 'A', url: 'https://example.com/post?utm_source=x', sourceName: 'one', sourceGroup: 'g', freshness: 'breaking_news' },
    { title: 'A copy', url: 'https://example.com/post', sourceName: 'two', sourceGroup: 'g', freshness: 'breaking_news' },
  ], new Map());
  assert.equal(result.observations.length, 2);
  assert.equal(result.newSources.length, 1);
  assert.equal(result.seenSources.length, 1);
  assert.equal(result.observations[0].source_lane, 'news');
});

test('source lane overrides keep knowledge and policy semantics stable', () => {
  const { resolveSourceLane, strongerLane } = require('../scripts/lib/source_lanes_lib');
  assert.equal(resolveSourceLane({ name: 'Search Engine Journal', freshness: 'breaking_news', category: 'seo_news' }), 'knowledge');
  assert.equal(resolveSourceLane({ name: 'Amazon Seller Central News', freshness: 'policy_update', category: 'official_policy' }), 'policy');
  assert.equal(strongerLane('knowledge', 'news'), 'news');
  assert.equal(strongerLane('policy', 'news'), 'policy');
});

test('AMZ123 kx fetch_page parser prioritizes news items over page-level links', async () => {
  const config = require('../scripts/lib/config_lib');
  const { collectHttpSources } = require('../scripts/lib/collect_http_lib');
  const oldGetSourceItems = config.getSourceItems;
  const oldFetch = global.fetch;
  const source = {
    name: 'AMZ123 - 跨境快讯',
    group: 'chinese_crossborder_news',
    type: 'fetch_page',
    category: 'chinese_crossborder_news',
    lane: 'news',
    priority: 'high',
    url: 'https://www.amz123.com/kx',
    freshness: 'breaking_news',
    requires_auth: 'false',
  };
  const html = `
    <a href="/hd/event">跨境新代码 AI 增长实战论坛 2026-06-17 广东省广州市</a>
    <div class="kx-item">
      <div class="kx-item-time">17:40</div>
      <a href="/kx/MxTPp7Jy" class="kx-item-title-index kx-item-title">
        <div>越南加强出境管控：10.5万企业负责人因税务违规受限，涉欠税610亿盾</div>
      </a>
      <div class="kx-item-description-index kx-item-description">AMZ123获悉，越南财政部正在联合公安部对信息技术系统进行升级，旨在优化出境限制的办理、解除及延期流程。</div>
    </div>
  `;

  try {
    config.getSourceItems = () => [source];
    global.fetch = async () => ({ ok: true, text: async () => html });
    const result = await collectHttpSources();
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].title, '越南加强出境管控：10.5万企业负责人因税务违规受限，涉欠税610亿盾');
    assert.equal(result.items[0].url, 'https://www.amz123.com/kx/MxTPp7Jy');
    assert.match(result.items[0].summary, /越南财政部/);
  } finally {
    config.getSourceItems = oldGetSourceItems;
    global.fetch = oldFetch;
  }
});

test('AMZ123 kx crawler uses API daily window before HTML fallback', async () => {
  const config = require('../scripts/lib/config_lib');
  const { collectHttpSources } = require('../scripts/lib/collect_http_lib');
  const oldGetSourceItems = config.getSourceItems;
  const oldFetch = global.fetch;
  const oldEngineNow = process.env.ENGINE_NOW;
  const oldDailyKey = process.env.ENGINE_DAILY_KEY;
  const calls = [];
  const source = {
    name: 'AMZ123 - 跨境快讯',
    group: 'chinese_crossborder_news',
    type: 'fetch_page',
    category: 'chinese_crossborder_news',
    lane: 'news',
    priority: 'high',
    url: 'https://www.amz123.com/kx',
    freshness: 'breaking_news',
    requires_auth: 'false',
  };
  const apiJson = {
    status: 0,
    info: 'ok',
    data: {
      total: 2,
      row_map: {
        1780243200: [{
          kx_content: [
            { id: '9GL6Bkjq', title: '美客多升级跨境品牌认证2.0：佣金最高减免9%', description: 'AMZ123获悉，美客多正式推出跨境品牌认证升级机制。', published_at: 1780307757 },
            { id: 'knprASGe', title: 'eBay日本Q1报告：高价手表与收藏卡牌需求攀升', description: 'AMZ123获悉，eBay日本发布第一季度跨境电商报告。', published_at: 1780307753 },
          ],
        }],
      },
    },
  };

  try {
    process.env.ENGINE_NOW = '2026-06-01T00:00:00.000Z';
    process.env.ENGINE_DAILY_KEY = '2026-06-01';
    config.getSourceItems = () => [source];
    global.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null });
      return { ok: true, status: 200, text: async () => JSON.stringify(apiJson) };
    };
    const result = await collectHttpSources();
    assert.equal(result.items.length, 2);
    assert.equal(result.items[0].url, 'https://www.amz123.com/kx/9GL6Bkjq');
    assert.equal(result.items[0].publishedAt, '2026-06-01 17:55:57');
    assert.equal(calls[0].url, 'https://api.amz123.com/ugc/v1/user_content/kx_list');
    assert.equal(calls[0].body.start_time, 1780243200);
    assert.equal(calls[0].body.end_time, 1780329599);
  } finally {
    config.getSourceItems = oldGetSourceItems;
    global.fetch = oldFetch;
    if (oldEngineNow === undefined) delete process.env.ENGINE_NOW;
    else process.env.ENGINE_NOW = oldEngineNow;
    if (oldDailyKey === undefined) delete process.env.ENGINE_DAILY_KEY;
    else process.env.ENGINE_DAILY_KEY = oldDailyKey;
  }
});

test('topic dedupe shadows exact duplicates and defers medium similarity', () => {
  const { decideTopicDedupe } = require('../scripts/lib/topic_dedupe_lib');
  const policy = { topic_dedupe: { shadow_similarity_threshold: 0.75, defer_similarity_threshold: 0.55 } };

  const medium = decideTopicDedupe(
    { topic: '让 AI 引用我的产品页面：亚马逊 Listing 需要补齐哪些可抽取信息', primaryKeyword: '让 AI 引用我的产品页面' },
    [{ id: 'old', topic: '让 AI 引用我的产品页面：亚马逊商品页要补哪些可抽取信息' }],
    policy
  );
  assert.equal(medium.decision, 'deferred_duplicate');

  const exact = decideTopicDedupe(
    { topic: 'ACoS 太高怎么降：关键词分层 SOP', primaryKeyword: 'ACoS 太高怎么降' },
    [{ id: 'old', topic: 'ACoS 太高怎么降：关键词分层 SOP' }],
    policy
  );
  assert.equal(exact.decision, 'shadow_duplicate');
});
