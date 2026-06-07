// pipeline_lib.js — DB-only 流水线核心（MySQL 唯一数据源；OpenClaw 结果从回复解析，不落运行时文件）
const fs = require('fs');
const path = require('path');
const my = require('./mysql_lib');
const providers = require('./providers');
const { extractJson } = providers;
const prompts = require('./prompt_lib');
const v = require('./validate_data_lib');
const { loadPolicy } = require('./production_policy_lib');
const { trustOf } = require('./sources_lib');
const config = require('./config_lib');
const trace = require('./trace_lib');
const runtime = require('./workflow_runtime_lib');
const { ingestCollectedSources, canonicalSourceIdsForUrls } = require('./source_ingest_lib');
const { shouldRunDailyQuery, sourcePriorityScore } = require('./source_lanes_lib');
const { decideTopicDedupe, duplicateDeferUntil } = require('./topic_dedupe_lib');
const { canonicalUrlHash, normalizedTopic } = require('./source_identity_lib');

// 子进程通过环境变量关联到 engine run 的 workflow step
function currentStepId() {
  return process.env.WORKFLOW_STEP_ID || null;
}

function estimateTokens(text) {
  if (!text) return 0;
  const s = String(text);
  const cjk = (s.match(/[\u3400-\u9fff]/g) || []).length;
  const rest = s.length - cjk;
  return Math.ceil(cjk + rest / 4);
}

function extractUsage(raw, prompt, response) {
  const usage = raw && (raw.usage || raw.token_usage || raw.response && raw.response.usage || raw.result && raw.result.usage);
  if (usage) {
    return {
      exact: true,
      inputTokens: usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokens ?? null,
      outputTokens: usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens ?? null,
      totalTokens: usage.total_tokens ?? usage.totalTokens ?? null,
      raw: usage,
    };
  }
  const inputTokens = estimateTokens(prompt);
  const outputTokens = estimateTokens(response);
  return { exact: false, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

const ROOT = my.ROOT;
const CHANNELS = ['wechat', 'douyin', 'xiaohongshu'];
const WEIGHTS = {
  balanced: { seo: 0.3, geo: 0.3, fact: 0.2, businessFit: 0.1, readability: 0.1 },
  seo_first: { seo: 0.45, geo: 0.15, fact: 0.2, businessFit: 0.1, readability: 0.1 },
  geo_first: { seo: 0.15, geo: 0.45, fact: 0.2, businessFit: 0.1, readability: 0.1 },
};

// 统一的 agent 调用 + model_runs 记录 + JSON 解析 + workflow 事件
async function callAgent({ taskType, prompt, sessionKey, engineRunId, articleId, articleVersionId, timeoutSec = 900 }) {
  // 任务节点路由：content_classification 走自己的配置（models.yaml），其余沿用既有映射
  const routeKey = taskType === 'article_generation' ? 'article_generation'
    : taskType === 'channel_repurpose' ? 'channel_repurpose'
    : taskType === 'content_classification' ? 'content_classification'
    : taskType === 'topic_value_score' ? 'topic_value_score'
    : taskType === 'article_quality_score' ? 'article_quality_score'
    : 'fact_check';
  const route = providers.resolveRoute(routeKey);
  const provider = route.providerKey;
  const model = route.model;
  const startedAt = my.now();
  const wallStartedAt = Date.now();
  const stepId = currentStepId();
  await trace.logWorkflowEvent({ engineRunId, workflowStepId: stepId, eventType: 'openclaw_call_started', level: 'info', message: `${provider} ${taskType} 调用开始`, relatedType: 'model_run', data: { task_type: taskType, provider, model_name: model, session_key: sessionKey } });

  const res = await providers.runTask({ taskType: routeKey, message: prompt, sessionKey, timeoutSec, route });
  const parsed = res.ok ? extractJson(res.visibleText) : null;
  const durationMs = res.durationMs ?? (Date.now() - wallStartedAt);
  const usage = extractUsage(res.raw, prompt, res.visibleText || '');
  const modelRunId = await my.recordModelRun({
    engineRunId, articleId, articleVersionId, taskType, provider, model, sessionKey,
    taskPrompt: prompt, rawResponse: res.ok ? (res.visibleText || '').slice(0, 4_000_000) : null,
    parsedOutput: parsed, status: res.ok && parsed ? 'succeeded' : 'failed', startedAt,
    error: res.ok ? (parsed ? null : '回复中无法解析 JSON') : res.error,
    rawSummary: {
      durationMs,
      promptChars: prompt.length,
      responseChars: (res.visibleText || '').length,
      usage,
    },
  });

  const ok = res.ok && !!parsed;
  await trace.logWorkflowEvent({
    engineRunId, workflowStepId: stepId,
    eventType: ok ? 'openclaw_call_completed' : 'openclaw_call_failed',
    level: ok ? 'info' : 'error',
    message: ok ? `${provider} ${taskType} 完成（${durationMs}ms）` : `${provider} ${taskType} 失败: ${(res.error || '无法解析 JSON').slice(0, 150)}`,
    relatedType: 'article', relatedId: articleId || null,
    data: { task_type: taskType, model_name: model, session_key: sessionKey, duration_ms: durationMs, parsed_ok: !!parsed, tokens: usage, cost: null },
  });
  if (!res.ok) return { ok: false, error: res.error, modelRunId };
  if (!parsed) return { ok: false, error: `回复中无法解析 JSON: ${(res.visibleText || '').slice(0, 150)}`, modelRunId };
  return { ok: true, data: parsed, modelRunId };
}

// ---------- 采集 ----------
async function collectSources({ engineRunId }) {
  await config.ensureInit();
  const stepId = currentStepId();
  const legacy = require('./collect_http_lib');
  const { items, summary, warnings, perSource } = await legacy.collectHttpSources();

  // search_query 走一次 agent（按 query 记录采集日志）
  const queries = config.getSourceItems().filter((s) => s.type === 'search_query' && s.query && shouldRunDailyQuery(s));
  let searchByQuery = {};
  if (queries.length) {
    const sStart = Date.now();
    const r = await callAgent({
      taskType: 'search_collection',
      prompt: prompts.searchCollectPrompt({ queries, nowIso: new Date().toISOString() }),
      sessionKey: `agent:main:collect-${Date.now() % 1e6}`,
      engineRunId, timeoutSec: 600,
    });
    const sDuration = Date.now() - sStart;
    if (r.ok && Array.isArray(r.data)) {
      const got = r.data.filter((x) => x && x.url && x.title).map((x) => ({
        title: String(x.title), url: String(x.url), summary: String(x.snippet || '').slice(0, 400),
        sourceName: String(x.sourceName || 'web_search'), sourceGroup: 'search_queries',
        sourceCategory: queries.find((q) => q.query === x.query)?.category || 'search',
        sourceLane: queries.find((q) => q.query === x.query)?.lane || 'news',
        sourcePriority: queries.find((q) => q.query === x.query)?.priority || 'high',
        sourceFreshness: queries.find((q) => q.query === x.query)?.freshness || 'breaking_news',
        itemType: 'search_query', publishedAt: '', _query: String(x.query || ''),
      }));
      summary.searchQuery = got.length;
      items.push(...got);
      for (const x of got) searchByQuery[x._query] = (searchByQuery[x._query] || 0) + 1;
      for (const q of queries) {
        await trace.logSourceCollection({
          engineRunId, workflowStepId: stepId, source: q,
          status: (searchByQuery[q.query] || 0) > 0 ? 'success' : 'partial',
          itemsFound: searchByQuery[q.query] || 0, itemsInserted: searchByQuery[q.query] || 0,
          durationMs: Math.round(sDuration / queries.length),
          warningMessage: (searchByQuery[q.query] || 0) === 0 ? '该 query 无结果' : null,
        });
      }
    } else {
      warnings.push(`search_query 采集失败: ${r.error}`);
      for (const q of queries) {
        await trace.logSourceCollection({ engineRunId, workflowStepId: stepId, source: q, status: 'failed', durationMs: sDuration, errorMessage: r.error });
      }
    }
  }

  const runRows = engineRunId ? await my.query('SELECT daily_key FROM engine_runs WHERE id = ? LIMIT 1', [engineRunId]) : [];
  const dailyKey = process.env.ENGINE_DAILY_KEY || (runRows[0] && runRows[0].daily_key) || null;
  const ingest = await ingestCollectedSources({ items, engineRunId, dailyKey, now: my.now(), trustOf });
  summary.total = ingest.observations;
  summary.inserted = ingest.insertedSources;
  summary.duplicatesHistorical = ingest.seenSources;
  summary.reactivated = ingest.reactivatedSources;
  summary.ignored = ingest.ignored;
  const insertedRows = ingest.insertedRows; // 供采集后内容分类
  const insertedBySource = ingest.insertedBySource;
  const observedBySource = ingest.observedBySource || {};
  warnings.push(...ingest.warnings);

  // 内容分类（规则优先；AI 限额 3 批，剩余低置信走 content:classify 回填）。失败不阻断采集。
  try {
    const { classifyRows } = require('./classify_lib');
    const cls = await classifyRows({ entity: 'source_items', rows: insertedRows, engineRunId, maxAiCalls: 3 });
    summary.classified = cls.classified;
    summary.classifiedByAi = cls.byAi;
    if (cls.failed > 0) warnings.push(`${cls.failed} 条 source_items 暂未分类（运行 npm run content:classify -- --entity source_items 回填）`);
  } catch (err) {
    warnings.push(`内容分类失败（不影响采集）: ${err.message.slice(0, 150)}`);
  }

  // 每个 HTTP 源写采集日志（items_inserted = 去重后真实入库数）
  for (const p of perSource) {
    await trace.logSourceCollection({
      engineRunId, workflowStepId: stepId, source: p.source, status: p.status, httpStatus: p.httpStatus,
      itemsFound: p.itemsFound, itemsInserted: observedBySource[p.source.name] || insertedBySource[p.source.name] || 0,
      durationMs: p.durationMs, errorMessage: p.errorMessage, warningMessage: p.warningMessage,
      sampleTitles: p.sampleTitles,
    });
    if (p.status === 'failed') {
      await trace.logWorkflowEvent({ engineRunId, workflowStepId: stepId, eventType: 'source_fetch_failed', level: 'warning', message: `${p.source.name}: ${p.errorMessage}`, relatedType: 'source', data: { source_group: p.source.group } });
    }
  }
  await trace.logWorkflowEvent({ engineRunId, workflowStepId: stepId, eventType: 'source_fetch_success', level: 'info', message: `采集完成: ${summary.total} 条入库（failed ${summary.failed} / skipped ${summary.skipped}）`, data: summary });

  return { summary, warnings };
}

function sourceScopePolicy(policy) {
  return {
    news_limit: 25,
    news_window_hours: 72,
    policy_limit: 15,
    policy_window_hours: 168,
    knowledge_limit: 40,
    knowledge_pool_limit: 120,
    knowledge_soft_expire_days: 90,
    ...(policy.source_scope || {}),
  };
}

function mysqlHoursAgo(hours) {
  const d = runtime.engineNowDate(process.env.ENGINE_NOW);
  d.setUTCHours(d.getUTCHours() - hours);
  return runtime.mysqlDateTimeFromDate(d);
}

function parseJsonArray(value) {
  const parsed = my.asJson(value);
  return Array.isArray(parsed) ? parsed : [];
}

function sourceConfigByName() {
  const map = new Map();
  for (const s of config.getSourceItems()) map.set(s.name, s);
  return map;
}

async function updateKnowledgePromptCounts(items) {
  const ids = [...new Set(items.filter((i) => i.lane === 'knowledge').map((i) => i.canonical_url_hash).filter(Boolean))];
  for (const hash of ids) {
    await my.query('UPDATE source_canonical_items SET times_in_prompt = times_in_prompt + 1, updated_at = ? WHERE canonical_url_hash = ?', [my.now(), hash]);
  }
}

async function selectTopicSourceItems({ engineRunId, policy }) {
  const scope = sourceScopePolicy(policy);
  const configByName = sourceConfigByName();
  const fields = `
    si.id, si.source_group, si.source_name, si.source_url, si.title, si.summary,
    si.content_type, si.business_category,
    sci.canonical_url_hash, sci.lane, sci.first_seen_at, sci.usage_status, sci.times_in_prompt,
    COUNT(so.id) AS observation_count,
    JSON_ARRAYAGG(so.id) AS observation_ids_json
  `;
  const groupBy = `
    si.id, si.source_group, si.source_name, si.source_url, si.title, si.summary,
    si.content_type, si.business_category,
    sci.canonical_url_hash, sci.lane, sci.first_seen_at, sci.usage_status, sci.times_in_prompt
  `;

  let news = [];
  let policyRows = [];
  if (engineRunId) {
    news = await my.query(`
      SELECT ${fields}
      FROM source_observations so
      JOIN source_canonical_items sci ON sci.canonical_url_hash = so.canonical_url_hash
      JOIN source_items si ON si.id = sci.source_item_id
      WHERE so.engine_run_id = ? AND sci.lane = 'news' AND sci.first_seen_at >= ?
      GROUP BY ${groupBy}
      ORDER BY MAX(so.created_at) DESC
      LIMIT ${Math.max(1, Math.min(200, scope.news_limit))}
    `, [engineRunId, mysqlHoursAgo(scope.news_window_hours)]);

    policyRows = await my.query(`
      SELECT ${fields}
      FROM source_observations so
      JOIN source_canonical_items sci ON sci.canonical_url_hash = so.canonical_url_hash
      JOIN source_items si ON si.id = sci.source_item_id
      WHERE so.engine_run_id = ? AND sci.lane = 'policy'
        AND (sci.first_seen_at >= ? OR sci.reactivated_at >= ?)
      GROUP BY ${groupBy}
      ORDER BY GREATEST(sci.first_seen_at, COALESCE(sci.reactivated_at, sci.first_seen_at)) DESC
      LIMIT ${Math.max(1, Math.min(200, scope.policy_limit))}
    `, [engineRunId, mysqlHoursAgo(scope.policy_window_hours), mysqlHoursAgo(scope.policy_window_hours)]);
  }

  const knowledgePool = await my.query(`
    SELECT si.id, si.source_group, si.source_name, si.source_url, si.title, si.summary,
           si.content_type, si.business_category,
           sci.canonical_url_hash, sci.lane, sci.first_seen_at, sci.usage_status, sci.times_in_prompt,
           0 AS observation_count,
           JSON_ARRAY() AS observation_ids_json
    FROM source_canonical_items sci
    JOIN source_items si ON si.id = sci.source_item_id
    WHERE sci.lane = 'knowledge' AND sci.usage_status = 'unused'
    ORDER BY sci.times_in_prompt ASC, sci.first_seen_at DESC
    LIMIT ${Math.max(scope.knowledge_limit, Math.min(500, scope.knowledge_pool_limit))}
  `);
  const knowledge = knowledgePool
    .map((row) => {
      const src = configByName.get(row.source_name) || {};
      const ageDays = row.first_seen_at ? Math.max(0, (runtime.engineNowDate(process.env.ENGINE_NOW).getTime() - new Date(row.first_seen_at).getTime()) / 86400000) : 0;
      const oldPenalty = ageDays > scope.knowledge_soft_expire_days ? 20 : 0;
      return {
        ...row,
        priority_rank: sourcePriorityScore(src),
        lane_sort_score: sourcePriorityScore(src) - Math.min(15, Math.floor(ageDays / 14)) - oldPenalty - (Number(row.times_in_prompt || 0) * 5),
      };
    })
    .sort((a, b) => b.lane_sort_score - a.lane_sort_score || Number(a.times_in_prompt || 0) - Number(b.times_in_prompt || 0))
    .slice(0, Math.max(1, Math.min(200, scope.knowledge_limit)));

  const combined = [...news, ...policyRows, ...knowledge];
  const seenIds = new Set();
  const deduped = combined.filter((row) => {
    if (seenIds.has(row.id)) return false;
    seenIds.add(row.id);
    return true;
  });
  await updateKnowledgePromptCounts(deduped);
  return {
    items: deduped,
    summary: { news: news.length, policy: policyRows.length, knowledge: knowledge.length, total: deduped.length, scope },
  };
}

async function insertTopicDedupeRecord({ engineRunId, topicCandidateId = null, candidate, decision, recordDecision }) {
  await my.insert('topic_dedupe_records', {
    id: my.makeId('tdedupe'),
    engine_run_id: engineRunId || null,
    topic_candidate_id: topicCandidateId,
    duplicate_of_topic_candidate_id: decision.duplicateOfTopicCandidateId || null,
    candidate_topic: String(candidate.topic || '').slice(0, 510),
    normalized_topic: normalizedTopic(candidate.topic || '').slice(0, 510),
    primary_keyword: candidate.primaryKeyword || null,
    decision: recordDecision,
    similarity: decision.similarity == null ? null : Number(decision.similarity.toFixed(4)),
    reason: decision.reason || null,
    raw_candidate_json: candidate,
    created_at: my.now(),
  });
}

async function insertTopicSignal({ engineRunId, observationId, sourceItemId, topicCandidateId, topic, status, score, reason, raw }) {
  await my.insert('topic_signals', {
    id: my.makeId('tsig'),
    engine_run_id: engineRunId || null,
    source_observation_id: observationId || null,
    source_item_id: sourceItemId || null,
    topic_candidate_id: topicCandidateId || null,
    signal_topic: topic ? String(topic).slice(0, 510) : null,
    status,
    score: score == null ? null : Math.round(score),
    reason: reason || null,
    raw_json: raw || null,
    created_at: my.now(),
  });
}

async function writeUnselectedObservationSignals({ engineRunId, allObservationIds, matchedObservationIds, sourceItemIdByObservationId }) {
  let count = 0;
  for (const observationId of allObservationIds) {
    if (matchedObservationIds.has(observationId)) continue;
    await insertTopicSignal({
      engineRunId,
      observationId,
      sourceItemId: sourceItemIdByObservationId.get(observationId) || null,
      topicCandidateId: null,
      topic: null,
      status: 'not_selected_by_model',
      reason: 'source observation was included in prompt scope but no candidate cited it',
    });
    count++;
  }
  return count;
}

// ---------- 主题生成（含去重节流，写 topic_candidates）----------
async function generateTopics({ engineRunId }) {
  await config.ensureInit();
  const policy = loadPolicy();
  let items = [];
  let sourceScope = 'global_recent';
  let sourceScopeSummary = null;
  if (engineRunId) {
    const scoped = await selectTopicSourceItems({ engineRunId, policy });
    items = scoped.items;
    sourceScope = 'engine_run_lanes';
    sourceScopeSummary = scoped.summary;
  }
  if (items.length === 0) {
    items = await my.query(`
      SELECT id, source_group, source_name, source_url, title, summary, content_type, business_category,
             NULL AS canonical_url_hash, NULL AS lane, 0 AS observation_count, JSON_ARRAY() AS observation_ids_json
      FROM source_items ORDER BY created_at DESC LIMIT 60
    `);
    sourceScope = 'global_recent_fallback';
  }
  if (items.length === 0) return { ok: false, error: '没有 source_items，请先 collect:sources' };
  const sourceIdsByUrl = new Map();
  const sourceIdsByHash = new Map();
  const allObservationIds = new Set();
  const matchedObservationIds = new Set();
  const sourceItemIdByObservationId = new Map();
  for (const item of items) {
    if (item.source_url) {
      if (!sourceIdsByUrl.has(item.source_url)) sourceIdsByUrl.set(item.source_url, []);
      sourceIdsByUrl.get(item.source_url).push(item.id);
      const hash = canonicalUrlHash(item.source_url);
      if (!sourceIdsByHash.has(hash)) sourceIdsByHash.set(hash, []);
      sourceIdsByHash.get(hash).push(item.id);
    }
    const obsIds = parseJsonArray(item.observation_ids_json);
    for (const obsId of obsIds) {
      allObservationIds.add(obsId);
      sourceItemIdByObservationId.set(obsId, item.id);
    }
  }
  const keywordsCsv = config.getKeywordsCsv();

  const daysAgo = (n) => {
    const d = runtime.engineNowDate(process.env.ENGINE_NOW);
    d.setUTCDate(d.getUTCDate() - n);
    return runtime.mysqlDateTimeFromDate(d);
  };
  const recentForRepetition = (await my.query("SELECT title FROM articles WHERE status != 'archived' AND created_at >= ? ORDER BY created_at DESC LIMIT 20", [daysAgo(30)])).map((x) => x.title);
  const r = await callAgent({
    taskType: 'topic_generation',
    prompt: prompts.topicGenerationPrompt({ sourceItems: items, keywordsCsv, recentTopics: recentForRepetition }),
    sessionKey: `agent:main:topicgen-${Date.now() % 1e6}`,
    engineRunId,
  });
  if (!r.ok) return { ok: false, error: r.error };

  const keywordSet = config.getKeywordSet();
  const validation = v.validateTopicCandidatesData(r.data, keywordSet);
  if (!validation.ok) return { ok: false, error: validation.issues.slice(0, 5).join('; ') };

  // 去重节流（production_policy）
  const d = policy.dedupe;
  const recentTopics = [
    ...(await my.query('SELECT id, title AS topic, NULL AS normalized_topic FROM articles WHERE created_at >= ?', [daysAgo(d.normalized_topic_window_days)])),
    ...(await my.query("SELECT id, topic, normalized_topic FROM topic_candidates WHERE created_at >= ? AND status != 'rejected'", [daysAgo(d.normalized_topic_window_days)])),
  ];

  const now = my.now();
  let inserted = 0;
  let shadowDuplicates = 0;
  let deferredDuplicates = 0;
  let deferredKeywords = 0;
  let uniqueInserted = 0;
  let topicSignals = { mergedIntoCandidate: 0, notSelectedByModel: 0, blockedDuplicate: 0 };
  for (const c of r.data.candidates) {
    const norm = normalizedTopic(c.topic);
    const exactExisting = await my.query('SELECT id, topic, normalized_topic FROM topic_candidates WHERE normalized_topic = ? LIMIT 1', [norm]);
    const kwCount = (await my.query('SELECT COUNT(*) c FROM articles WHERE primary_keyword = ? AND created_at >= ?', [c.primaryKeyword, daysAgo(d.primary_keyword_window_days)]))[0].c;
    const decision = decideTopicDedupe(
      c,
      exactExisting.length ? [...exactExisting, ...recentTopics] : recentTopics,
      policy,
      {
        keywordArticleCount: kwCount,
        keywordLimit: d.max_articles_per_primary_keyword_in_window,
      }
    );

    // 内容分类：优先采用主题生成 AI 直出（继承/修正后的结果），缺失或非法时回退规则分类
    const tax = require('./taxonomy_lib');
    let cls = tax.normalizeClassification({
      contentType: c.contentType, businessCategory: c.businessCategory, topicCluster: c.topicCluster || '',
      confidence: 0.9, reason: '[topic_generation] 主题生成时由 AI 判定（继承/修正 source 分类）',
    });
    let clsBy = 'topic_generation';
    if (!cls || !cls.contentType || !cls.businessCategory) {
      cls = tax.classifyByRules({ title: c.topic, summary: [c.contentAngle, c.businessAngle].filter(Boolean).join('；') });
      clsBy = 'rules';
    }

    const topicId = my.makeId('topiccand');
    const sourceUrls = Array.isArray(c.sourceUrls) ? c.sourceUrls : [];
    const canonicalMatches = await canonicalSourceIdsForUrls(sourceUrls);
    const sourceItemIds = [...new Set(sourceUrls.flatMap((url) => {
      const direct = sourceIdsByUrl.get(url) || [];
      const byHash = sourceIdsByHash.get(canonicalUrlHash(url)) || [];
      const canonical = canonicalMatches.get(url) ? [canonicalMatches.get(url)] : [];
      return [...direct, ...byHash, ...canonical];
    }))];
    const candidateObservationIds = [];
    for (const item of items) {
      if (!sourceItemIds.includes(item.id)) continue;
      candidateObservationIds.push(...parseJsonArray(item.observation_ids_json));
    }

    if (decision.decision === 'shadow_duplicate') {
      await insertTopicDedupeRecord({ engineRunId, candidate: c, decision, recordDecision: 'shadow_duplicate' });
      shadowDuplicates++;
      for (const obsId of new Set(candidateObservationIds)) {
        matchedObservationIds.add(obsId);
        await insertTopicSignal({
          engineRunId, observationId: obsId, sourceItemId: sourceItemIdByObservationId.get(obsId) || null,
          topicCandidateId: null, topic: c.topic, status: 'blocked_duplicate', score: c.score,
          reason: decision.reason, raw: c,
        });
        topicSignals.blockedDuplicate++;
      }
      await trace.logWorkflowEvent({
        engineRunId, workflowStepId: currentStepId(),
        eventType: 'topic_candidate_shadow_duplicate',
        level: 'warning',
        message: `重复候选未入池: ${c.topic.slice(0, 50)}（${(decision.reason || '').slice(0, 80)}）`,
        relatedType: 'topic_dedupe_record', data: { score: c.score, similarity: decision.similarity },
      });
      continue;
    }

    let status = 'candidate';
    let selectionStatus = null;
    let selectionSkipReason = null;
    let deferredUntil = null;
    let recordDecision = 'unique_inserted';
    if (decision.decision === 'deferred_duplicate') {
      status = 'deferred';
      selectionStatus = 'skipped_duplicate';
      selectionSkipReason = decision.reason;
      deferredUntil = duplicateDeferUntil(runtime.engineNowDate(process.env.ENGINE_NOW), policy.topic_dedupe?.duplicate_defer_days || 14);
      recordDecision = 'deferred_duplicate';
      deferredDuplicates++;
    } else if (decision.decision === 'deferred_keyword') {
      status = 'deferred';
      selectionStatus = 'skipped_recent_keyword';
      selectionSkipReason = decision.reason;
      deferredUntil = duplicateDeferUntil(runtime.engineNowDate(process.env.ENGINE_NOW), policy.topic_dedupe?.duplicate_defer_days || 14);
      recordDecision = 'deferred_keyword';
      deferredKeywords++;
    } else {
      uniqueInserted++;
    }

    await my.insert('topic_candidates', {
      id: topicId, engine_run_id: engineRunId, topic: c.topic.slice(0, 510), normalized_topic: norm.slice(0, 510),
      primary_keyword: c.primaryKeyword, secondary_keywords_json: c.secondaryKeywords || [], category: c.category,
      content_angle: c.contentAngle, business_angle: c.businessAngle, source_item_ids_json: sourceItemIds, source_urls_json: sourceUrls,
      score: Math.round(c.score), raw_score: Math.round(c.score),
      content_value_score: c.contentValueScore != null ? Math.round(c.contentValueScore) : null,
      value_breakdown_json: c.contentValueScore != null ? {
        sellerPainValue: c.sellerPainValue, actionability: c.actionability, informationGain: c.informationGain,
        businessFit: c.businessFit, nonRepetition: c.nonRepetition, sourceSupport: c.sourceSupport,
      } : null,
      priority: c.priority, status,
      reject_reason: c.rejectRisk || null,
      selection_status: selectionStatus,
      selection_skip_reason: selectionSkipReason,
      deferred_until: deferredUntil,
      content_type: cls ? cls.contentType : null, business_category: cls ? cls.businessCategory : null,
      topic_cluster: cls ? cls.topicCluster : null,
      classification_confidence: cls ? cls.confidence : null, classification_reason: cls ? cls.reason : null,
      created_at: now, updated_at: now,
    });
    if (cls && cls.contentType) {
      await my.insert('content_classifications', {
        id: my.makeId('cls'), entity_type: 'topic_candidates', entity_id: topicId,
        content_type: cls.contentType, business_category: cls.businessCategory, topic_cluster: cls.topicCluster,
        confidence: cls.confidence, reason: cls.reason, classifier_type: clsBy, model_run_id: null, raw_json: null, created_at: now,
      });
    }
    await insertTopicDedupeRecord({ engineRunId, topicCandidateId: topicId, candidate: c, decision, recordDecision });
    for (const obsId of new Set(candidateObservationIds)) {
      matchedObservationIds.add(obsId);
      await insertTopicSignal({
        engineRunId, observationId: obsId, sourceItemId: sourceItemIdByObservationId.get(obsId) || null,
        topicCandidateId: topicId, topic: c.topic, status: 'merged_into_candidate', score: c.score,
        reason: null, raw: c,
      });
      topicSignals.mergedIntoCandidate++;
    }
    inserted++;
    await trace.logWorkflowEvent({
      engineRunId, workflowStepId: currentStepId(),
      eventType: selectionSkipReason ? 'topic_candidate_deferred_by_dedupe' : 'topic_candidate_created',
      level: selectionSkipReason ? 'warning' : 'info',
      message: selectionSkipReason ? `候选 deferred: ${c.topic.slice(0, 50)}（${selectionSkipReason.slice(0, 80)}）` : `候选入池: ${c.topic.slice(0, 50)}（${c.score} 分）`,
      relatedType: 'topic_candidate', data: { score: c.score, priority: c.priority, sourceItemIds: sourceItemIds.length },
    });
  }
  topicSignals.notSelectedByModel = await writeUnselectedObservationSignals({ engineRunId, allObservationIds, matchedObservationIds, sourceItemIdByObservationId });
  return {
    ok: true,
    inserted,
    duplicates: shadowDuplicates,
    dedupeRejected: shadowDuplicates,
    dedupeAdvisory: deferredDuplicates + deferredKeywords,
    topicDedupe: { uniqueInserted, shadowDuplicates, deferredDuplicates, deferredKeywords },
    topicSignals,
    sourceScope,
    sourceScopeSummary,
    warnings: validation.warnings.slice(0, 10),
  };
}

// ---------- 文章 job ----------
function deriveFcStatus(readiness) {
  if (readiness === 'needs_fact_sources') return 'needs_fact_sources';
  if (readiness === 'ready_after_minor_edits') return 'ready_for_review';
  if (readiness === 'not_ready') return 'fact_check_failed';
  return 'article_validated';
}

async function markKnowledgeSourcesUsed(topicCandidateId, articleId) {
  if (!topicCandidateId || !articleId) return 0;
  const row = (await my.query('SELECT source_item_ids_json FROM topic_candidates WHERE id = ? LIMIT 1', [topicCandidateId]))[0];
  const ids = parseJsonArray(row && row.source_item_ids_json).filter(Boolean);
  if (!ids.length) return 0;
  let updated = 0;
  for (const sourceItemId of [...new Set(ids)]) {
    const res = await my.query(`
      UPDATE source_canonical_items
      SET usage_status = 'used',
          used_at = ?,
          used_by_article_id = ?,
          updated_at = ?
      WHERE source_item_id = ? AND lane = 'knowledge' AND usage_status = 'unused'
    `, [my.now(), articleId, my.now(), sourceItemId]);
    updated += res.affectedRows || 0;
  }
  return updated;
}

async function runArticleJob(job, { engineRunId, maxAttempts = 3 }) {
  await config.ensureInit();
  await my.update('article_jobs', { status: 'running', updated_at: my.now() }, 'id = ?', [job.id]);
  await trace.logStatusTransition({ entityType: 'article_job', entityId: job.id, engineRunId, fromStatus: job.status, toStatus: 'running' });
  const jobData = {
    ...job,
    secondaryKeywords: my.asJson(job.secondary_keywords_json) || [],
    sourceUrls: my.asJson(job.source_urls_json) || [],
  };

  let failures = [];
  let parsed = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const r = await callAgent({
      taskType: 'article_generation',
      prompt: prompts.articleJobPrompt({ job: jobData, attempt, previousFailures: failures }),
      sessionKey: `agent:main:content-${job.id}-a${attempt}`,
      engineRunId,
    });
    if (!r.ok) { failures = [r.error]; continue; }
    const validation = v.validateArticleData(r.data.article, r.data.quality);
    if (validation.ok) { parsed = r.data; break; }
    failures = validation.issues.slice(0, 8);
    await trace.logWorkflowEvent({ engineRunId, workflowStepId: currentStepId(), eventType: 'validation_failed', level: 'warning', message: `job ${job.id} 第 ${attempt} 次输出未通过校验: ${failures.slice(0, 3).join('; ').slice(0, 200)}`, relatedType: 'article_job', relatedId: job.id });
  }

  if (!parsed) {
    await my.update('article_jobs', { status: 'failed', error_message: failures.join('; ').slice(0, 900), updated_at: my.now() }, 'id = ?', [job.id]);
    await trace.logStatusTransition({ entityType: 'article_job', entityId: job.id, engineRunId, fromStatus: 'running', toStatus: 'failed', reason: failures.slice(0, 2).join('; ').slice(0, 200) });
    return { ok: false, jobId: job.id, failures: failures.slice(0, 5) };
  }

  const { article, quality } = parsed;
  // slug 唯一性强制（production_policy reject_if_slug_exists 的落地点）：撞车则确定性加后缀
  let slug = article.slug;
  let n = 2;
  while ((await my.query('SELECT id FROM articles WHERE slug = ? LIMIT 1', [slug])).length) {
    slug = `${article.slug}-${n++}`;
  }
  if (slug !== article.slug) article.slug = slug;

  const now = my.now();
  const articleId = my.makeId('article');
  const versionId = my.makeId('ver');
  const { providerKey: provider, model } = providers.resolveRoute('article_generation');
  const articleStatus = quality.publishRecommendation === 'reject' ? 'rejected' : 'article_validated';
  const strategy = job.strategy || 'balanced';

  // 内容分类：job 透传（选题继承链），job 缺失时按文章标题规则分类
  const tax = require('./taxonomy_lib');
  let cls = job.content_type ? {
    contentType: job.content_type, businessCategory: job.business_category, topicCluster: job.topic_cluster,
    confidence: null, reason: '继承自选题分类（topic_candidate → article_job → article）',
  } : tax.classifyByRules({ title: article.articleTitle, summary: job.content_angle || '' });

  await my.insert('articles', {
    id: articleId, engine_run_id: engineRunId, topic_candidate_id: job.topic_candidate_id, current_version_id: versionId,
    title: article.articleTitle.slice(0, 510), slug: article.slug, primary_keyword: article.primaryKeyword,
    secondary_keywords_json: article.secondaryKeywords || [], status: articleStatus,
    quality_score: quality.score, publish_recommendation: quality.publishRecommendation,
    content_type: cls ? cls.contentType : null, business_category: cls ? cls.businessCategory : null,
    topic_cluster: cls ? cls.topicCluster : null,
    visual_plan_json: article.visualPlan || null,
    created_at: now, updated_at: now,
  });
  await my.insert('article_versions', {
    id: versionId, article_id: articleId, engine_run_id: engineRunId, article_job_id: job.id,
    topic_candidate_id: job.topic_candidate_id, model_provider: provider, model_name: model,
    version_label: strategy !== 'balanced' ? `v1_${strategy}` : 'v1', generation_mode: 'single_model', strategy,
    title: article.articleTitle.slice(0, 510), slug: article.slug, status: articleStatus === 'rejected' ? 'rejected' : 'validated',
    article_markdown: article.articleMarkdown, article_json: article, quality_json: quality,
    quality_score: quality.score, publish_recommendation: quality.publishRecommendation,
    content_type: cls ? cls.contentType : null, business_category: cls ? cls.businessCategory : null,
    topic_cluster: cls ? cls.topicCluster : null,
    visual_plan_json: article.visualPlan || null,
    content_sha256: my.sha256(article.articleMarkdown), created_at: now, updated_at: now,
  });
  if (cls && cls.contentType) {
    await my.insert('content_classifications', {
      id: my.makeId('cls'), entity_type: 'articles', entity_id: articleId,
      content_type: cls.contentType, business_category: cls.businessCategory, topic_cluster: cls.topicCluster,
      confidence: cls.confidence, reason: cls.reason,
      classifier_type: job.content_type ? 'inherited' : 'rules', model_run_id: null, raw_json: null, created_at: now,
    });
  }
  await my.insert('quality_reports', {
    id: my.makeId('quality'), article_id: articleId, article_version_id: versionId, score: quality.score,
    publish_recommendation: quality.publishRecommendation, facts_score: quality.breakdown ? quality.breakdown.facts : null,
    issues_json: quality.issues || [], required_fixes_json: quality.requiredFixes || [], raw_json: quality, created_at: now,
  });
  await my.update('article_jobs', { status: 'generated', updated_at: now }, 'id = ?', [job.id]);
  if (job.topic_candidate_id) {
    await my.update('topic_candidates', { status: 'generated', updated_at: now }, 'id = ?', [job.topic_candidate_id]);
    await markKnowledgeSourcesUsed(job.topic_candidate_id, articleId);
    await trace.logStatusTransition({ entityType: 'topic_candidate', entityId: job.topic_candidate_id, engineRunId, fromStatus: 'selected', toStatus: 'generated' });
  }
  await trace.logStatusTransition({ entityType: 'article_job', entityId: job.id, engineRunId, fromStatus: 'running', toStatus: 'generated' });
  await trace.logStatusTransition({ entityType: 'article', entityId: articleId, engineRunId, fromStatus: null, toStatus: articleStatus, reason: `质量门 ${quality.score}/${quality.publishRecommendation}` });
  await trace.logStatusTransition({ entityType: 'article_version', entityId: versionId, engineRunId, fromStatus: null, toStatus: articleStatus === 'rejected' ? 'rejected' : 'validated' });
  return { ok: true, jobId: job.id, articleId, versionId, title: article.articleTitle, qualityScore: quality.score, publishRecommendation: quality.publishRecommendation };
}

// ---------- 文章质量主评分（>=80 才能进终审；SEO/GEO 不能覆盖）----------
const ARTICLE_QUALITY_MIN = 80;

async function scoreArticleQuality(article, { engineRunId, force = false }) {
  await config.ensureInit();
  const ver = await my.latestVersion(article.id);
  if (!ver || !ver.article_markdown) return { ok: false, articleId: article.id, error: '无版本正文' };
  if (!force && ver.article_quality_score != null) {
    return { ok: true, skipped: true, articleId: article.id, articleQualityScore: ver.article_quality_score };
  }
  const recentSince = runtime.engineNowDate(process.env.ENGINE_NOW);
  recentSince.setUTCDate(recentSince.getUTCDate() - 30);
  const recentTitles = (await my.query("SELECT title FROM articles WHERE id != ? AND status != 'archived' AND created_at >= ? ORDER BY created_at DESC LIMIT 15", [article.id, runtime.mysqlDateTimeFromDate(recentSince)])).map((x) => x.title);
  const visualPlan = my.asJson(ver.visual_plan_json) || (my.asJson(ver.article_json) || {}).visualPlan || null;

  const r = await callAgent({
    taskType: 'article_quality_score',
    prompt: prompts.articleQualityPrompt({ article, articleMarkdown: ver.article_markdown, contentType: article.content_type, recentTitles, visualPlan }),
    sessionKey: `agent:main:artquality-${article.id}-${Date.now() % 1e5}`,
    engineRunId, articleId: article.id, articleVersionId: ver.id,
  });
  if (!r.ok) return { ok: false, articleId: article.id, error: r.error };
  const validation = v.validateArticleQualityData(r.data);
  if (!validation.ok) return { ok: false, articleId: article.id, error: validation.issues.slice(0, 5).join('; ') };

  const q = r.data;
  const b = q.breakdown;
  const now = my.now();
  await my.insert('article_quality_scores', {
    id: my.makeId('aqscore'), article_id: article.id, article_version_id: ver.id, engine_run_id: engineRunId,
    article_quality_score: Math.round(q.articleQualityScore),
    seller_pain_fit: b.sellerPainFit, actionability: b.actionability, information_gain: b.informationGain,
    originality: b.originality, clarity: b.clarity, evidence_use: b.evidenceUse, business_usefulness: b.businessUsefulness,
    recommendation: q.qualityRecommendation, raw_json: q, created_at: now,
  });
  await my.update('article_versions', { article_quality_json: q, article_quality_score: Math.round(q.articleQualityScore), updated_at: now }, 'id = ?', [ver.id]);
  await my.update('articles', { article_quality_score: Math.round(q.articleQualityScore), updated_at: now }, 'id = ?', [article.id]);
  await trace.logWorkflowEvent({
    engineRunId, workflowStepId: currentStepId(), eventType: 'article_quality_scored',
    level: q.articleQualityScore >= ARTICLE_QUALITY_MIN ? 'info' : 'warning',
    message: `文章质量主评分: ${article.id} = ${q.articleQualityScore}（${q.qualityRecommendation}）${q.articleQualityScore < ARTICLE_QUALITY_MIN ? ' — 低于 80，阻止进入终审' : ''}`,
    relatedType: 'article', relatedId: article.id,
    data: { score: q.articleQualityScore, recommendation: q.qualityRecommendation, mustFix: (q.mustFix || []).length },
  });
  return { ok: true, skipped: false, articleId: article.id, articleQualityScore: Math.round(q.articleQualityScore), recommendation: q.qualityRecommendation, mustFix: q.mustFix || [] };
}

// 终审门禁：拟进入 ready_for_review 时检查主评分（缺失则现场评分）
async function gateReadyForReview(article, intendedStatus, { engineRunId }) {
  if (intendedStatus !== 'ready_for_review') return { status: intendedStatus, gated: false };
  let score = (await my.query('SELECT article_quality_score FROM articles WHERE id = ?', [article.id]))[0].article_quality_score;
  let scoreOk = true;
  if (score == null) {
    const r = await scoreArticleQuality(article, { engineRunId });
    scoreOk = r.ok;
    score = r.ok ? r.articleQualityScore : null;
  }
  const gate = runtime.decideReadyGate({ intendedStatus, score, scoreOk, minScore: ARTICLE_QUALITY_MIN });
  if (gate.gated && score == null) {
    await trace.logWorkflowEvent({ engineRunId, workflowStepId: currentStepId(), eventType: 'article_quality_score_failed', level: 'warning', message: `文章 ${article.id} 质量评分失败，阻止进入终审`, relatedType: 'article', relatedId: article.id });
  }
  return gate;
}

// ---------- 事实核查（对某文章的当前版本）----------
async function factCheckArticle(article, { engineRunId }) {
  await config.ensureInit();
  const ver = await my.latestVersion(article.id);
  if (!ver || !ver.article_markdown) return { ok: false, articleId: article.id, error: '无版本正文' };
  const quality = my.asJson(ver.quality_json) || { score: article.quality_score, publishRecommendation: article.publish_recommendation };

  const r = await callAgent({
    taskType: 'fact_check',
    prompt: prompts.factCheckPrompt({ articleMarkdown: ver.article_markdown, quality, label: `article: ${article.id}` }),
    sessionKey: `agent:main:factcheck-${article.id}-${Date.now() % 1e5}`,
    engineRunId, articleId: article.id, articleVersionId: ver.id,
  });
  if (!r.ok) return { ok: false, articleId: article.id, error: r.error };
  const validation = v.validateFactCheckData(r.data);
  if (!validation.ok) return { ok: false, articleId: article.id, error: validation.issues.slice(0, 5).join('; ') };

  const fc = r.data;
  const now = my.now();
  let newStatus = deriveFcStatus(fc.publishReadiness);
  const gate = await gateReadyForReview(article, newStatus, { engineRunId });
  if (gate.gated) newStatus = gate.status;
  await my.insert('fact_checks', {
    id: my.makeId('factcheck'), article_id: article.id, article_version_id: ver.id,
    overall_risk: fc.overallRisk, publish_readiness: fc.publishReadiness, claims_count: validation.summary.claims,
    high_risk_count: validation.summary.highRisk, medium_risk_count: validation.summary.mediumRisk,
    source_needed_count: validation.summary.sourceNeeded, must_fix_count: validation.summary.mustFix,
    must_fix_json: fc.mustFixBeforePublish || [], raw_json: fc, created_at: now,
  });
  await my.update('article_versions', { fact_check_json: fc, fact_publish_readiness: fc.publishReadiness, status: newStatus === 'article_validated' ? 'fact_checked' : newStatus, updated_at: now }, 'id = ?', [ver.id]);
  await my.update('articles', { status: newStatus, fact_overall_risk: fc.overallRisk, fact_publish_readiness: fc.publishReadiness, updated_at: now }, 'id = ?', [article.id]);
  if (article.status !== newStatus) {
    await trace.logStatusTransition({ entityType: 'article', entityId: article.id, engineRunId, fromStatus: article.status, toStatus: newStatus, reason: gate.gated ? gate.reason : `fact check: ${fc.publishReadiness}, mustFix ${validation.summary.mustFix}` });
    await trace.logWorkflowEvent({ engineRunId, workflowStepId: currentStepId(), eventType: 'status_changed', level: 'info', message: `文章 ${article.id}: ${article.status} → ${newStatus}`, relatedType: 'article', relatedId: article.id });
  }
  return { ok: true, articleId: article.id, articleStatus: newStatus, overallRisk: fc.overallRisk, publishReadiness: fc.publishReadiness, claims: validation.summary.claims, mustFix: validation.summary.mustFix };
}

// ---------- 渠道改写 ----------
async function generateChannelsForArticle(article, { engineRunId, missingOnly = false, force = false }) {
  await config.ensureInit();
  const ver = await my.latestVersion(article.id);
  if (!ver || !ver.article_markdown) return { generated: [], skipped: [], failed: [{ channel: '*', issues: ['无版本正文'] }] };
  const existingRows = await my.query('SELECT channel FROM channel_outputs WHERE article_id = ? AND article_version_id = ?', [article.id, ver.id]);
  const existing = existingRows.map((c) => c.channel);

  let toGen = force ? [...CHANNELS] : CHANNELS.filter((c) => !existing.includes(c));
  const skipped = CHANNELS.filter((c) => !toGen.includes(c) || (existing.includes(c) && !force)).filter((c) => !toGen.includes(c));
  if (toGen.length === 0) return { generated: [], skipped: [...CHANNELS], failed: [] };

  const articleJson = my.asJson(ver.article_json) || {};
  const r = await callAgent({
    taskType: 'channel_repurpose',
    prompt: prompts.channelsPrompt({
      articleMarkdown: ver.article_markdown, articleJson,
      quality: my.asJson(ver.quality_json), factCheck: my.asJson(ver.fact_check_json),
      channels: toGen, label: `article: ${article.id}`,
    }),
    sessionKey: `agent:main:channels-${article.id}-${Date.now() % 1e5}`,
    engineRunId, articleId: article.id, articleVersionId: ver.id,
  });

  const generated = [];
  const failed = [];
  const now = my.now();
  for (const ch of toGen) {
    const data = r.ok ? r.data[ch] : null;
    const validation = data ? v.validateChannelData(data, ch) : { ok: false, issues: [r.error || `回复缺少 ${ch}`] };
    if (!validation.ok) { failed.push({ channel: ch, issues: validation.issues.slice(0, 3) }); continue; }
    const existingRow = (await my.query('SELECT id FROM channel_outputs WHERE article_id = ? AND article_version_id = ? AND channel = ?', [article.id, ver.id, ch]))[0];
    const fields = {
      title: (data.title || '').slice(0, 510), content_markdown: data.contentMarkdown, content_json: data,
      status: 'validated', content_sha256: my.sha256(data.contentMarkdown), updated_at: now,
    };
    if (existingRow && force) await my.update('channel_outputs', fields, 'id = ?', [existingRow.id]);
    else if (!existingRow) {
      const choutId = my.makeId('chout');
      await my.insert('channel_outputs', { id: choutId, article_id: article.id, article_version_id: ver.id, channel: ch, created_at: now, ...fields });
      await trace.logStatusTransition({ entityType: 'channel_output', entityId: choutId, engineRunId, fromStatus: null, toStatus: 'validated', data: { channel: ch, article_id: article.id } });
    }
    generated.push(ch);
  }
  return { generated, skipped, failed };
}

// ---------- fix:sources 三步 ----------
async function resolveSourcesForArticle(article, { engineRunId }) {
  await config.ensureInit();
  const ver = await my.latestVersion(article.id);
  const fc = my.asJson(ver && ver.fact_check_json);
  if (!fc) return { ok: false, error: '无 fact_check_json' };
  const claims = (fc.claims || []).filter((c) => (c.action === 'cite_required' || c.action === 'soften') && c.sourceNeeded === true);
  const mustFix = fc.mustFixBeforePublish || [];
  if (!claims.length && !mustFix.length) return { ok: false, error: '没有待补来源事项' };

  const r = await callAgent({
    taskType: 'source_resolution',
    prompt: prompts.sourceResolutionPrompt({ article, articleJson: my.asJson(ver.article_json) || {}, articleMarkdown: ver.article_markdown, claims, mustFix }),
    sessionKey: `agent:main:source-resolution-${article.id}-${Date.now() % 1e5}`,
    engineRunId, articleId: article.id, articleVersionId: ver.id,
  });
  if (!r.ok) return { ok: false, error: r.error };
  const validation = v.validateSourceResolutionData(r.data);
  if (!validation.ok) return { ok: false, error: validation.issues.slice(0, 5).join('; ') };

  const now = my.now();
  const latestFc = (await my.query('SELECT id FROM fact_checks WHERE article_id = ? ORDER BY created_at DESC LIMIT 1', [article.id]))[0];
  for (const it of r.data.items) {
    const src = it.source || {};
    await my.insert('source_resolutions', {
      id: my.makeId('srcres'), article_id: article.id, article_version_id: ver.id, fact_check_id: latestFc ? latestFc.id : null,
      claim_text: it.claim, claim_category: it.claimCategory || null, risk: it.risk || null, action: it.action || null,
      recommended_source_group: it.recommendedSourceGroup || null, resolved_status: it.resolvedStatus,
      source_url: src.url || null, source_title: (src.title || '').slice(0, 510) || null, source_name: src.sourceName || null,
      source_type: src.sourceType || null, source_trust: src.sourceTrust || null,
      evidence_summary: it.evidenceSummary || null, suggested_rewrite: it.suggestedRewrite || null, notes: it.notes || null,
      raw_json: it, created_at: now, updated_at: now,
    });
  }
  await my.update('article_versions', { source_resolution_json: r.data, updated_at: now }, 'id = ?', [ver.id]);
  return { ok: true, resolution: r.data, summary: validation.summary };
}

async function reviseArticleWithResolution(article, resolution, { engineRunId }) {
  await config.ensureInit();
  const ver = await my.latestVersion(article.id);
  const articleJson = my.asJson(ver.article_json);
  const fc = my.asJson(ver.fact_check_json) || {};
  const r = await callAgent({
    taskType: 'article_revision',
    prompt: prompts.revisionPrompt({ article, articleJson, resolution, mustFix: fc.mustFixBeforePublish || [] }),
    sessionKey: `agent:main:revision-${article.id}-${Date.now() % 1e5}`,
    engineRunId, articleId: article.id, articleVersionId: ver.id,
  });
  if (!r.ok) return { ok: false, error: r.error };
  const validation = v.validateRevisedArticleData(r.data, articleJson, resolution);
  if (!validation.ok) return { ok: false, error: validation.issues.slice(0, 5).join('; ') };

  const now = my.now();
  const versionCount = (await my.query('SELECT COUNT(*) c FROM article_versions WHERE article_id = ?', [article.id]))[0].c;
  const newVersionId = my.makeId('ver');
  const { providerKey: provider, model } = providers.resolveRoute('article_generation');
  await my.insert('article_versions', {
    id: newVersionId, article_id: article.id, engine_run_id: engineRunId, model_provider: provider, model_name: model,
    version_label: `v${versionCount + 1}`, generation_mode: 'fact_checked_revision', strategy: ver.strategy || 'balanced',
    title: r.data.articleTitle.slice(0, 510), slug: r.data.slug, status: 'generated',
    article_markdown: r.data.articleMarkdown, article_json: r.data,
    quality_json: my.asJson(ver.quality_json), source_resolution_json: resolution,
    quality_score: ver.quality_score, publish_recommendation: ver.publish_recommendation,
    // 分类随版本链继承
    content_type: ver.content_type || article.content_type || null,
    business_category: ver.business_category || article.business_category || null,
    topic_cluster: ver.topic_cluster || article.topic_cluster || null,
    visual_plan_json: r.data.visualPlan || my.asJson(ver.visual_plan_json) || null,
    content_sha256: my.sha256(r.data.articleMarkdown), created_at: now, updated_at: now,
  });
  if (r.data.visualPlan) {
    await my.update('articles', { visual_plan_json: r.data.visualPlan, updated_at: now }, 'id = ?', [article.id]);
  }
  await my.update('articles', { current_version_id: newVersionId, updated_at: now }, 'id = ?', [article.id]);
  await my.query('UPDATE source_resolutions SET article_version_id = ?, updated_at = ? WHERE article_id = ? AND article_version_id = ?', [newVersionId, now, article.id, ver.id]);
  await trace.logStatusTransition({ entityType: 'article_version', entityId: newVersionId, engineRunId, fromStatus: null, toStatus: 'generated', reason: `修订版本 v${versionCount + 1}（fact_checked_revision）`, data: { article_id: article.id } });
  return { ok: true, versionId: newVersionId, warnings: validation.warnings };
}

// ---------- SEO/GEO 评分 ----------
async function scoreArticle(article, { engineRunId, strategy = 'balanced', force = false }) {
  await config.ensureInit();
  const ver = await my.latestVersion(article.id);
  if (!ver || !ver.article_markdown) return { ok: false, articleId: article.id, error: '无版本正文' };
  if (!force) {
    const existing = await my.query('SELECT id FROM seo_geo_scores WHERE article_id = ? AND article_version_id = ? AND strategy = ? LIMIT 1', [article.id, ver.id, strategy]);
    if (existing.length) return { ok: true, skipped: true, articleId: article.id };
  }
  const r = await callAgent({
    taskType: 'seo_geo_score',
    prompt: prompts.scorePrompt({
      article, articleMarkdown: ver.article_markdown, articleJson: my.asJson(ver.article_json) || {},
      factCheck: my.asJson(ver.fact_check_json), sourceResolution: my.asJson(ver.source_resolution_json),
      strategy, weights: WEIGHTS[strategy],
    }),
    sessionKey: `agent:main:seogeo-${article.id}-${Date.now() % 1e5}`,
    engineRunId, articleId: article.id, articleVersionId: ver.id,
  });
  if (!r.ok) return { ok: false, articleId: article.id, error: r.error };
  const validation = v.validateScoreSetData(r.data, WEIGHTS);
  if (!validation.ok) return { ok: false, articleId: article.id, error: validation.issues.slice(0, 5).join('; ') };

  const { seo, geo, dual } = r.data;
  const now = my.now();
  await my.insert('seo_geo_scores', {
    id: my.makeId('score'), article_id: article.id, article_version_id: ver.id, engine_run_id: engineRunId,
    strategy: dual.strategy, overall_score: Math.round(dual.overallScore), seo_score: Math.round(dual.seoScore),
    geo_score: Math.round(dual.geoScore), fact_score: Math.round(dual.factScore),
    business_fit_score: Math.round(dual.businessFitScore), readability_score: Math.round(dual.readabilityScore),
    recommendation: dual.recommendation, seo_json: seo, geo_json: geo, dual_json: dual, created_at: now,
  });
  await my.update('article_versions', { seo_score_json: seo, geo_score_json: geo, dual_quality_json: dual, seo_score: Math.round(dual.seoScore), geo_score: Math.round(dual.geoScore), updated_at: now }, 'id = ?', [ver.id]);
  await my.update('articles', { seo_score: Math.round(dual.seoScore), geo_score: Math.round(dual.geoScore), updated_at: now }, 'id = ?', [article.id]);
  return { ok: true, skipped: false, articleId: article.id, summary: validation.summary };
}

module.exports = { CHANNELS, WEIGHTS, callAgent, collectSources, generateTopics, runArticleJob, factCheckArticle, generateChannelsForArticle, resolveSourcesForArticle, reviseArticleWithResolution, scoreArticle, scoreArticleQuality, gateReadyForReview, deriveFcStatus, ARTICLE_QUALITY_MIN };
