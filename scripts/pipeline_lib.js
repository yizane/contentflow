// pipeline_lib.js — DB-only 流水线核心（MySQL 唯一数据源；OpenClaw 结果从回复解析，不落运行时文件）
const fs = require('fs');
const path = require('path');
const my = require('./mysql_lib');
const { runAgentTask, extractJson, modelFor } = require('./openclaw_lib');
const prompts = require('./prompt_lib');
const v = require('./validate_data_lib');
const { loadPolicy, jaccard } = require('./production_policy_lib');
const { trustOf } = require('./sources_lib');
const config = require('./config_lib');
const trace = require('./trace_lib');

// 子进程通过环境变量关联到 engine run 的 workflow step
function currentStepId() {
  return process.env.WORKFLOW_STEP_ID || null;
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
  const { provider, model } = modelFor(taskType === 'article_generation' ? 'article_generation' : taskType === 'channel_repurpose' ? 'channel_repurpose' : 'fact_check');
  const startedAt = my.now();
  const stepId = currentStepId();
  await trace.logWorkflowEvent({ engineRunId, workflowStepId: stepId, eventType: 'openclaw_call_started', level: 'info', message: `OpenClaw ${taskType} 调用开始`, relatedType: 'model_run', data: { task_type: taskType, model_name: model, session_key: sessionKey } });

  const res = runAgentTask({ sessionKey, message: prompt, timeoutSec });
  const parsed = res.ok ? extractJson(res.visibleText) : null;
  await my.recordModelRun({
    engineRunId, articleId, articleVersionId, taskType, provider, model, sessionKey,
    taskPrompt: prompt, rawResponse: res.ok ? (res.visibleText || '').slice(0, 4_000_000) : null,
    parsedOutput: parsed, status: res.ok && parsed ? 'succeeded' : 'failed', startedAt,
    error: res.ok ? (parsed ? null : '回复中无法解析 JSON') : res.error,
  });

  const ok = res.ok && !!parsed;
  await trace.logWorkflowEvent({
    engineRunId, workflowStepId: stepId,
    eventType: ok ? 'openclaw_call_completed' : 'openclaw_call_failed',
    level: ok ? 'info' : 'error',
    message: ok ? `OpenClaw ${taskType} 完成（${res.durationMs}ms）` : `OpenClaw ${taskType} 失败: ${(res.error || '无法解析 JSON').slice(0, 150)}`,
    relatedType: 'article', relatedId: articleId || null,
    data: { task_type: taskType, model_name: model, session_key: sessionKey, duration_ms: res.durationMs, parsed_ok: !!parsed, tokens: null, cost: null },
  });
  if (!res.ok) return { ok: false, error: res.error };
  if (!parsed) return { ok: false, error: `回复中无法解析 JSON: ${(res.visibleText || '').slice(0, 150)}` };
  return { ok: true, data: parsed };
}

// ---------- 采集 ----------
async function collectSources({ engineRunId }) {
  await config.ensureInit();
  const stepId = currentStepId();
  const legacy = require('./collect_http_lib');
  const { items, summary, warnings, perSource } = await legacy.collectHttpSources();

  // search_query 走一次 agent（按 query 记录采集日志）
  const queries = config.getSourceItems().filter((s) => s.type === 'search_query' && s.query);
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
        sourceCategory: queries.find((q) => q.query === x.query)?.category || 'search', itemType: 'search_query', publishedAt: '', _query: String(x.query || ''),
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

  // url 去重 + 入库
  const seen = new Set();
  const deduped = items.filter((it) => it.url && !seen.has(it.url) && seen.add(it.url));
  summary.total = deduped.length;
  const now = my.now();
  const insertedBySource = {};
  for (const it of deduped) {
    await my.insert('source_items', {
      id: my.makeId('source'), engine_run_id: engineRunId, source_name: it.sourceName, source_group: it.sourceGroup,
      source_url: it.url, source_type: it.itemType, source_trust: trustOf(it.sourceCategory),
      title: (it.title || '').slice(0, 510), summary: it.summary || null, content_text: null,
      retrieved_at: now, as_of: (it.publishedAt || '').slice(0, 32) || null, raw_json: it, created_at: now,
    });
    insertedBySource[it.sourceName] = (insertedBySource[it.sourceName] || 0) + 1;
  }

  // 每个 HTTP 源写采集日志（items_inserted = 去重后真实入库数）
  for (const p of perSource) {
    await trace.logSourceCollection({
      engineRunId, workflowStepId: stepId, source: p.source, status: p.status, httpStatus: p.httpStatus,
      itemsFound: p.itemsFound, itemsInserted: insertedBySource[p.source.name] || 0,
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

// ---------- 主题生成（含去重节流，写 topic_candidates）----------
async function generateTopics({ engineRunId }) {
  await config.ensureInit();
  const items = await my.query('SELECT source_group, source_name, source_url, title, summary FROM source_items ORDER BY created_at DESC LIMIT 60');
  if (items.length === 0) return { ok: false, error: '没有 source_items，请先 collect:sources' };
  const keywordsCsv = config.getKeywordsCsv();

  const r = await callAgent({
    taskType: 'topic_generation',
    prompt: prompts.topicGenerationPrompt({ sourceItems: items, keywordsCsv }),
    sessionKey: `agent:main:topicgen-${Date.now() % 1e6}`,
    engineRunId,
  });
  if (!r.ok) return { ok: false, error: r.error };

  const keywordSet = config.getKeywordSet();
  const validation = v.validateTopicCandidatesData(r.data, keywordSet);
  if (!validation.ok) return { ok: false, error: validation.issues.slice(0, 5).join('; ') };

  // 去重节流（production_policy）
  const policy = loadPolicy();
  const d = policy.dedupe;
  const daysAgo = (n) => my.now().slice(0, 10 + 13) && new Date(Date.now() - n * 86400000).toISOString().slice(0, 23).replace('T', ' ');
  const recentTopics = [
    ...(await my.query('SELECT title AS t FROM articles WHERE created_at >= ?', [daysAgo(d.normalized_topic_window_days)])).map((x) => x.t),
    ...(await my.query("SELECT topic AS t FROM topic_candidates WHERE created_at >= ? AND status != 'rejected'", [daysAgo(d.normalized_topic_window_days)])).map((x) => x.t),
  ];

  const now = my.now();
  let inserted = 0;
  let duplicates = 0;
  let dedupeRejected = 0;
  for (const c of r.data.candidates) {
    const norm = c.topic.replace(/\s+/g, '');
    const exists = await my.query('SELECT id FROM topic_candidates WHERE normalized_topic = ? LIMIT 1', [norm]);
    if (exists.length) { duplicates++; continue; }

    let rejection = null;
    if (policy.topic_generation.reject_if_similar_topic_recent) {
      for (const t of recentTopics) {
        const sim = jaccard(c.topic, t);
        if (sim >= 0.55) { rejection = `近 ${d.normalized_topic_window_days} 天高相似主题（Jaccard ${sim.toFixed(2)}）: ${t.slice(0, 40)}`; break; }
      }
    }
    if (!rejection) {
      const kwCount = (await my.query('SELECT COUNT(*) c FROM articles WHERE primary_keyword = ? AND created_at >= ?', [c.primaryKeyword, daysAgo(d.primary_keyword_window_days)]))[0].c;
      if (kwCount >= d.max_articles_per_primary_keyword_in_window) rejection = `primary_keyword 近 ${d.primary_keyword_window_days} 天已 ${kwCount} 篇`;
    }

    await my.insert('topic_candidates', {
      id: my.makeId('topiccand'), engine_run_id: engineRunId, topic: c.topic.slice(0, 510), normalized_topic: norm.slice(0, 510),
      primary_keyword: c.primaryKeyword, secondary_keywords_json: c.secondaryKeywords || [], category: c.category,
      content_angle: c.contentAngle, business_angle: c.businessAngle, source_item_ids_json: [], source_urls_json: c.sourceUrls || [],
      score: Math.round(c.score), priority: c.priority, status: rejection ? 'rejected' : 'candidate',
      reject_reason: rejection ? `[dedupe] ${rejection}` : c.rejectRisk || null, created_at: now, updated_at: now,
    });
    if (rejection) dedupeRejected++;
    else inserted++;
    await trace.logWorkflowEvent({
      engineRunId, workflowStepId: currentStepId(),
      eventType: rejection ? 'topic_candidate_rejected' : 'topic_candidate_created',
      level: rejection ? 'warning' : 'info',
      message: rejection ? `候选被去重拒绝: ${c.topic.slice(0, 50)}（${rejection.slice(0, 80)}）` : `候选入池: ${c.topic.slice(0, 50)}（${c.score} 分）`,
      relatedType: 'topic_candidate', data: { score: c.score, priority: c.priority },
    });
  }
  return { ok: true, inserted, duplicates, dedupeRejected, warnings: validation.warnings.slice(0, 10) };
}

// ---------- 文章 job ----------
function deriveFcStatus(readiness) {
  if (readiness === 'needs_fact_sources') return 'needs_fact_sources';
  if (readiness === 'ready_after_minor_edits') return 'ready_for_review';
  if (readiness === 'not_ready') return 'fact_check_failed';
  return 'article_validated';
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
  const { provider, model } = modelFor('article_generation');
  const articleStatus = quality.publishRecommendation === 'reject' ? 'rejected' : 'article_validated';
  const strategy = job.strategy || 'balanced';

  await my.insert('articles', {
    id: articleId, engine_run_id: engineRunId, topic_candidate_id: job.topic_candidate_id, current_version_id: versionId,
    title: article.articleTitle.slice(0, 510), slug: article.slug, primary_keyword: article.primaryKeyword,
    secondary_keywords_json: article.secondaryKeywords || [], status: articleStatus,
    quality_score: quality.score, publish_recommendation: quality.publishRecommendation,
    created_at: now, updated_at: now,
  });
  await my.insert('article_versions', {
    id: versionId, article_id: articleId, engine_run_id: engineRunId, article_job_id: job.id,
    topic_candidate_id: job.topic_candidate_id, model_provider: provider, model_name: model,
    version_label: strategy !== 'balanced' ? `v1_${strategy}` : 'v1', generation_mode: 'single_model', strategy,
    title: article.articleTitle.slice(0, 510), slug: article.slug, status: articleStatus === 'rejected' ? 'rejected' : 'validated',
    article_markdown: article.articleMarkdown, article_json: article, quality_json: quality,
    quality_score: quality.score, publish_recommendation: quality.publishRecommendation,
    content_sha256: my.sha256(article.articleMarkdown), created_at: now, updated_at: now,
  });
  await my.insert('quality_reports', {
    id: my.makeId('quality'), article_id: articleId, article_version_id: versionId, score: quality.score,
    publish_recommendation: quality.publishRecommendation, facts_score: quality.breakdown ? quality.breakdown.facts : null,
    issues_json: quality.issues || [], required_fixes_json: quality.requiredFixes || [], raw_json: quality, created_at: now,
  });
  await my.update('article_jobs', { status: 'generated', updated_at: now }, 'id = ?', [job.id]);
  if (job.topic_candidate_id) {
    await my.update('topic_candidates', { status: 'generated', updated_at: now }, 'id = ?', [job.topic_candidate_id]);
    await trace.logStatusTransition({ entityType: 'topic_candidate', entityId: job.topic_candidate_id, engineRunId, fromStatus: 'selected', toStatus: 'generated' });
  }
  await trace.logStatusTransition({ entityType: 'article_job', entityId: job.id, engineRunId, fromStatus: 'running', toStatus: 'generated' });
  await trace.logStatusTransition({ entityType: 'article', entityId: articleId, engineRunId, fromStatus: null, toStatus: articleStatus, reason: `质量门 ${quality.score}/${quality.publishRecommendation}` });
  await trace.logStatusTransition({ entityType: 'article_version', entityId: versionId, engineRunId, fromStatus: null, toStatus: articleStatus === 'rejected' ? 'rejected' : 'validated' });
  return { ok: true, jobId: job.id, articleId, versionId, title: article.articleTitle, qualityScore: quality.score, publishRecommendation: quality.publishRecommendation };
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
  const newStatus = deriveFcStatus(fc.publishReadiness);
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
    await trace.logStatusTransition({ entityType: 'article', entityId: article.id, engineRunId, fromStatus: article.status, toStatus: newStatus, reason: `fact check: ${fc.publishReadiness}, mustFix ${validation.summary.mustFix}` });
    await trace.logWorkflowEvent({ engineRunId, workflowStepId: currentStepId(), eventType: 'status_changed', level: 'info', message: `文章 ${article.id}: ${article.status} → ${newStatus}`, relatedType: 'article', relatedId: article.id });
  }
  return { ok: true, articleId: article.id, articleStatus: newStatus, overallRisk: fc.overallRisk, publishReadiness: fc.publishReadiness, claims: validation.summary.claims, mustFix: validation.summary.mustFix };
}

// ---------- 渠道改写 ----------
async function generateChannelsForArticle(article, { engineRunId, missingOnly = false, force = false }) {
  await config.ensureInit();
  const ver = await my.latestVersion(article.id);
  if (!ver || !ver.article_markdown) return { generated: [], skipped: [], failed: [{ channel: '*', issues: ['无版本正文'] }] };
  const existingRows = await my.query('SELECT channel FROM channel_outputs WHERE article_id = ?', [article.id]);
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
    const existingRow = (await my.query('SELECT id FROM channel_outputs WHERE article_id = ? AND channel = ?', [article.id, ch]))[0];
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
  const { provider, model } = modelFor('article_generation');
  await my.insert('article_versions', {
    id: newVersionId, article_id: article.id, engine_run_id: engineRunId, model_provider: provider, model_name: model,
    version_label: `v${versionCount + 1}`, generation_mode: 'fact_checked_revision', strategy: ver.strategy || 'balanced',
    title: r.data.articleTitle.slice(0, 510), slug: r.data.slug, status: 'generated',
    article_markdown: r.data.articleMarkdown, article_json: r.data,
    quality_json: my.asJson(ver.quality_json), source_resolution_json: resolution,
    quality_score: ver.quality_score, publish_recommendation: ver.publish_recommendation,
    content_sha256: my.sha256(r.data.articleMarkdown), created_at: now, updated_at: now,
  });
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

module.exports = { CHANNELS, WEIGHTS, callAgent, collectSources, generateTopics, runArticleJob, factCheckArticle, generateChannelsForArticle, resolveSourcesForArticle, reviseArticleWithResolution, scoreArticle, deriveFcStatus };
