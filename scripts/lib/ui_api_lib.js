// ui_api_lib.js — ContentFlow 监控台（webpage/）专用聚合查询层
// 把 MySQL 真实数据整形成前端页面需要的形状；只读为主，终审/配置开关为受控写入。
const my = require('./mysql_lib');
const rc = require('./run_control_lib');

// ---------- 通用映射 ----------
// workflow_steps.step_key → 前端 7 步流水线 key（db_list 是快照步骤，不展示）
const STEP_KEY_MAP = {
  sources_collect: 'collect',
  topics_generate: 'topics',
  jobs_create: 'tasks',
  jobs_run: 'generate',
  factcheck_run: 'factcheck',
  channels_generate: 'channels',
  'score_seo-geo': 'score',
};
const STEP_ORDER = ['collect', 'topics', 'tasks', 'generate', 'factcheck', 'channels', 'score'];

const CHANNEL_KEY = { wechat: 'wechat', douyin: 'douyin', xiaohongshu: 'xhs' };
const CHANNEL_NAME = { wechat: '公众号长文', douyin: '抖音口播稿', xiaohongshu: '小红书笔记' };

function chStatus(s) {
  if (['validated', 'success', 'succeeded', 'generated'].includes(s)) return 'success';
  if (['failed', 'validation_failed'].includes(s)) return 'fail';
  return 'pending';
}

function factMeta(readiness) {
  switch (readiness) {
    case 'ready': return { fact: 'publish', factText: '通过' };
    case 'ready_after_minor_edits': return { fact: 'publish', factText: '微调后可发' };
    case 'needs_fact_sources': return { fact: 'needs', factText: '待补来源' };
    case 'not_ready': case 'failed': return { fact: 'failed', factText: '核查未过' };
    default: return { fact: null, factText: '未核查' };
  }
}

function runStatus(s) {
  return { succeeded: 'success', success: 'success', failed: 'failed', running: 'running', partial: 'partial' }[s] || s;
}

function dt(v) { return v ? new Date(v).toISOString() : null; }
function durMs(a, b) { return a && b ? new Date(b) - new Date(a) : null; }
// 本地日历日（YYYY-MM-DD）。dt() 是 UTC ISO，不能用 slice(0,10) 和本地 dailyKey 比较，会跨日错位
function localDay(v) { return v ? rc.getDailyKey(new Date(v)) : null; }

// 质量门 breakdown → 中文维度（含满分）
const QUALITY_DIMS = [
  ['searchIntent', '搜索意图', 20], ['informationGain', '信息增量', 20], ['actionability', '可操作性', 15],
  ['seo', 'SEO 友好', 15], ['geo', 'GEO 友好', 15], ['facts', '事实严谨', 10], ['brandFit', '品牌契合', 5],
];
const SEO_DIMS = [
  ['searchIntentMatch', '搜索意图匹配', 15], ['keywordTargeting', '关键词定位', 15], ['serpDifferentiation', 'SERP 差异化', 15],
  ['titleMetaOptimization', '标题/元描述', 10], ['headingStructure', 'H 标签结构', 10], ['internalLinkOpportunity', '内链机会', 10],
  ['schemaReadiness', '结构化数据', 10], ['freshnessAndSource', '时效与来源', 10], ['readability', '可读性', 5],
];
const GEO_DIMS = [
  ['answerFirst', '答案前置', 15], ['extractableStructure', '可提取结构', 15], ['entityClarity', '实体清晰度', 15],
  ['citationReadiness', '引用就绪度', 15], ['questionCoverage', '问答覆盖', 10], ['comparisonAndCriteria', '对比与标准', 10],
  ['factualCaution', '事实谨慎度', 10], ['chunkability', '可分块性', 10],
];

function mapDims(defs, breakdown) {
  if (!breakdown) return [];
  return defs.map(([k, label, max]) => [label, breakdown[k] == null ? 0 : breakdown[k], max]);
}

// ---------- 流水线步骤 ----------
// 步骤摘要：按 step key 生成中文摘要 + 指标；缺信息时回退到通用格式
function stepSummary(key, status, out, errorMessage) {
  const o = out || {};
  const s = o.summary || o;
  const metrics = [];
  let summary = '';
  if (key === 'collect') {
    if (s.total != null) {
      summary = `抓到 ${s.total} 条${s.failed ? `，${s.failed} 个源失败` : ''}${s.skipped ? `，跳过 ${s.skipped}` : ''}`;
      metrics.push(['抓取', s.total], ['失败源', s.failed || 0], ['跳过', s.skipped || 0]);
      if (s.rss != null) metrics.push(['RSS', s.rss]);
    }
  } else if (key === 'topics') {
    if (o.inserted != null) {
      summary = `新增 ${o.inserted} 个候选${o.dedupeRejected ? `，去重拒绝 ${o.dedupeRejected}` : ''}`;
      metrics.push(['候选', o.inserted], ['重复', o.duplicates || 0], ['去重拒绝', o.dedupeRejected || 0]);
    }
  } else if (key === 'tasks') {
    if (o.created != null || o.jobsCreated != null) {
      const n = o.created != null ? o.created : o.jobsCreated;
      summary = `创建 ${n} 个文章任务`;
      metrics.push(['任务', n]);
    }
  } else if (key === 'generate') {
    if (o.generated != null || o.succeeded != null) {
      const n = o.generated != null ? o.generated : o.succeeded;
      summary = `生成 ${n} 篇文章${o.failed ? `，失败 ${o.failed}` : ''}`;
      metrics.push(['生成', n], ['失败', o.failed || 0]);
    }
  } else if (key === 'factcheck') {
    if (o.checked != null || o.completed != null) {
      const n = o.checked != null ? o.checked : o.completed;
      summary = `核查 ${n} 篇`;
      metrics.push(['核查', n]);
    }
  } else if (key === 'channels') {
    if (o.generated != null || o.succeeded != null) {
      const n = o.generated != null ? o.generated : o.succeeded;
      summary = `生成渠道稿 ${n} 篇${o.failed ? `，失败 ${o.failed}` : ''}`;
      metrics.push(['成功', n], ['失败', o.failed || 0]);
    }
  } else if (key === 'score') {
    if (o.scored != null) {
      summary = `评分 ${o.scored} 篇${o.skipped ? `，跳过 ${o.skipped}` : ''}${o.failed ? `，失败 ${o.failed}` : ''}`;
      metrics.push(['评分', o.scored], ['跳过', o.skipped || 0], ['失败', o.failed || 0]);
    }
  }
  if (!summary) {
    // 通用回退：取 output 里的数值字段
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'number' && metrics.length < 4) metrics.push([k, v]);
    }
    summary = o.error || (Array.isArray(o.warnings) && o.warnings[0]) || (status === 'success' ? '完成' : status === 'skipped' ? '已跳过' : '');
  }
  if (status === 'failed' && !summary) summary = errorMessage || '步骤失败';
  return { summary, metrics };
}

// 真实 workflow_steps → 前端 7 步
function mapWorkflowSteps(rows) {
  const byKey = {};
  for (const r of rows) {
    const key = STEP_KEY_MAP[r.step_key];
    if (!key) continue;
    const out = my.asJson(r.output_summary_json);
    const warn = my.asJson(r.warning_json);
    const { summary, metrics } = stepSummary(key, r.status, out, r.error_message);
    byKey[key] = {
      key, status: r.status, dur: r.duration_ms || durMs(r.started_at, r.finished_at) || 0,
      summary: summary || '—', metrics,
      error: r.status === 'failed' ? (r.error_message || (out && out.error) || '步骤失败') : null,
      reason: r.status === 'skipped' ? ((out && out.reason) || '上游步骤未完成，已跳过') : null,
      warnings: Array.isArray(warn) ? warn.slice(0, 5) : (out && Array.isArray(out.warnings) ? out.warnings.slice(0, 5) : []),
    };
  }
  return STEP_ORDER.map((k) => byKey[k] || { key: k, status: 'pending', dur: 0, summary: '等待中', metrics: [] });
}

// 老 run 没有 workflow_steps 时：用 engine_runs 统计字段合成步骤状态
function synthSteps(run, topicsCount) {
  const counters = {
    collect: { n: run.topics_collected, label: (n) => `入库 ${n} 条资讯`, metric: '入库' },
    topics: { n: topicsCount, label: (n) => `生成 ${n} 个候选选题`, metric: '候选' },
    tasks: { n: run.topics_selected, label: (n) => `选中 ${n} 个选题`, metric: '选中' },
    generate: { n: run.articles_generated, label: (n) => `生成 ${n} 篇文章`, metric: '生成' },
    factcheck: { n: run.fact_checks_completed, label: (n) => `完成 ${n} 次核查`, metric: '核查' },
    channels: { n: run.channel_outputs_generated, label: (n) => `生成 ${n} 篇渠道稿`, metric: '渠道稿' },
    score: { n: null, label: () => '评分完成', metric: null },
  };
  const finished = ['succeeded', 'failed', 'partial'].includes(run.status);
  let failedMarked = false;
  return STEP_ORDER.map((k) => {
    const c = counters[k];
    const n = c.n;
    let status; let summary;
    if (run.status === 'running') {
      status = n > 0 ? 'success' : 'pending';
      summary = n > 0 ? c.label(n) : '等待中';
    } else if (run.status === 'succeeded') {
      status = 'success';
      summary = n != null ? c.label(n || 0) : c.label();
    } else if (finished && (n === 0 || n == null) && !failedMarked && run.status === 'failed') {
      failedMarked = true;
      status = 'failed';
      summary = run.error_message ? String(run.error_message).slice(0, 120) : '步骤失败';
    } else if (failedMarked) {
      status = 'pending';
      summary = '等待中';
    } else {
      status = n > 0 ? 'success' : 'pending';
      summary = n > 0 ? c.label(n) : '等待中';
    }
    return {
      key: k, status, dur: 0, summary, synthetic: true,
      metrics: n != null && c.metric ? [[c.metric, n]] : [],
      error: status === 'failed' ? (run.error_message || null) : null, reason: null, warnings: [],
    };
  });
}

async function stepsForRun(run) {
  const rows = await my.query('SELECT * FROM workflow_steps WHERE engine_run_id = ? ORDER BY step_order', [run.id]);
  if (rows.length) return mapWorkflowSteps(rows);
  const topicsCount = (await my.query('SELECT COUNT(*) c FROM topic_candidates WHERE engine_run_id = ?', [run.id]))[0].c;
  return synthSteps(run, topicsCount);
}

// 今日状态：not_started / running / success / partial / failed
function todayState(run, steps) {
  if (!run) return 'not_started';
  if (run.status === 'running') return 'running';
  if (run.status === 'failed') return 'failed';
  if (run.status === 'partial') return 'partial';
  if (run.status === 'succeeded') {
    return steps.some((s) => s.status === 'failed') ? 'partial' : 'success';
  }
  return 'failed';
}

// ---------- 文章列表 ----------
async function listArticlesUI(limit = 100) {
  const arts = await my.query(
    `SELECT a.id, a.title, a.slug, a.status, a.quality_score, a.seo_score, a.geo_score,
            a.fact_publish_readiness, a.publish_recommendation, a.engine_run_id, a.topic_candidate_id,
            a.content_type, a.business_category, a.topic_cluster, a.article_quality_score,
            a.created_at, a.updated_at, t.score topic_score, t.priority topic_priority
     FROM articles a LEFT JOIN topic_candidates t ON t.id = a.topic_candidate_id
     ORDER BY a.created_at DESC LIMIT ${Math.min(200, limit)}`);
  if (!arts.length) return [];
  const ids = arts.map((a) => a.id);
  const ph = ids.map(() => '?').join(',');
  const [chRows, scoreRows, verRows, humanRows] = await Promise.all([
    my.query(`SELECT article_id, channel, status FROM channel_outputs WHERE article_id IN (${ph}) ORDER BY created_at`, ids),
    my.query(`SELECT article_id, overall_score, created_at FROM seo_geo_scores WHERE article_id IN (${ph}) ORDER BY created_at`, ids),
    my.query(`SELECT article_id, CHAR_LENGTH(article_markdown) len, created_at FROM article_versions WHERE article_id IN (${ph}) ORDER BY created_at`, ids),
    my.query(`SELECT DISTINCT article_id FROM source_resolutions WHERE resolved_status = 'needs_manual_review' AND article_id IN (${ph})`, ids),
  ]);
  const chBy = {}; chRows.forEach((r) => { (chBy[r.article_id] = chBy[r.article_id] || {})[CHANNEL_KEY[r.channel] || r.channel] = chStatus(r.status); });
  const overallBy = {}; scoreRows.forEach((r) => { overallBy[r.article_id] = r.overall_score; }); // 最后一条生效
  const wordsBy = {}; verRows.forEach((r) => { wordsBy[r.article_id] = r.len; });
  const humanSet = new Set(humanRows.map((r) => r.article_id));
  return arts.map((a) => ({
    id: a.id, slug: a.slug, title: a.title, status: a.status,
    quality: a.quality_score || 0, seo: a.seo_score || 0, geo: a.geo_score || 0,
    overall: overallBy[a.id] || 0,
    ...factMeta(a.fact_publish_readiness),
    // 待补来源细分：有「需人工介入」表述的算人工待办，其余为系统自动补源中
    needsHuman: a.status === 'needs_fact_sources' && humanSet.has(a.id),
    contentType: a.content_type, businessCategory: a.business_category, topicCluster: a.topic_cluster,
    articleQualityScore: a.article_quality_score ?? null,
    words: wordsBy[a.id] || 0,
    created: dt(a.created_at), updated: dt(a.updated_at), createdDay: localDay(a.created_at),
    topicScore: a.topic_score, priority: a.topic_priority || '—',
    channels: { wechat: 'pending', douyin: 'pending', xhs: 'pending', ...(chBy[a.id] || {}) },
    engineRunId: a.engine_run_id,
  }));
}

// ---------- 运行历史 ----------
const SCOPE_NOTE = { batch: '批量运行（engine:batch）', manual: '手动运行' };
async function listRunsUI(limit = 30) {
  const rows = await my.query(`SELECT * FROM engine_runs ORDER BY started_at DESC LIMIT ${Math.min(100, limit)}`);
  return rows.map((r) => ({
    id: r.id, key: r.daily_key || localDay(r.started_at) || '—',
    status: r.is_active ? runStatus(r.status) : 'superseded',
    mode: r.run_mode || 'start', scope: r.run_scope,
    runner: (my.asJson(r.summary_json) || {}).runner || null, // langgraph 实验 runner 标识
    trigger: r.trigger_source || '—', actor: r.triggered_by || r.trigger_source || 'system',
    topics: r.topics_collected || 0, selected: r.topics_selected || 0,
    articles: r.articles_generated || 0, checks: r.fact_checks_completed || 0,
    channels: r.channel_outputs_generated || 0,
    started: dt(r.started_at), finished: dt(r.finished_at), durMs: durMs(r.started_at, r.finished_at),
    note: !r.is_active && r.superseded_by ? `被 ${r.superseded_by} 替代` : (SCOPE_NOTE[r.run_scope] || null),
    error: r.error_message || null,
  }));
}

// ---------- 选题池 ----------
async function listTopicsUI(dailyKey) {
  // 优先取今天的候选；没有则取最近 60 个
  let rows = await my.query('SELECT * FROM topic_candidates WHERE created_at >= ? ORDER BY score DESC LIMIT 120', [`${dailyKey} 00:00:00`]);
  let scope = 'today';
  if (!rows.length) {
    rows = await my.query('SELECT * FROM topic_candidates ORDER BY created_at DESC, score DESC LIMIT 60');
    scope = 'recent';
  }
  const ids = rows.map((r) => r.id);
  let artBy = {};
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    (await my.query(`SELECT id, topic_candidate_id FROM articles WHERE topic_candidate_id IN (${ph})`, ids))
      .forEach((a) => { artBy[a.topic_candidate_id] = a.id; });
  }
  return {
    scope,
    topics: rows.map((r) => ({
      id: r.id, title: r.topic, score: r.score || 0, priority: r.priority || 'P2',
      status: r.status, reason: r.reject_reason || '',
      srcCount: (my.asJson(r.source_item_ids_json) || my.asJson(r.source_urls_json) || []).length,
      contentType: r.content_type, businessCategory: r.business_category, topicCluster: r.topic_cluster,
      rawScore: r.raw_score, selectionScore: r.selection_score, selectionStatus: r.selection_status,
      skipReason: r.selection_skip_reason || null, deferredUntil: r.deferred_until ? dt(r.deferred_until) : null,
      articleId: artBy[r.id] || null, created: dt(r.created_at),
    })),
  };
}

// ---------- 近 7 天产能 ----------
async function trend7d() {
  const since = new Date(Date.now() - 6 * 86400000);
  const sinceStr = since.toISOString().slice(0, 10) + ' 00:00:00';
  const sinceKey = rc.getDailyKey(since);
  const [arts, reviews, dayRuns] = await Promise.all([
    my.query("SELECT DATE(created_at) d, COUNT(*) c FROM articles WHERE created_at >= ? GROUP BY DATE(created_at)", [sinceStr]),
    my.query("SELECT DATE(created_at) d, COUNT(DISTINCT entity_id) c FROM status_transitions WHERE to_status = 'ready_for_review' AND created_at >= ? GROUP BY DATE(created_at)", [sinceStr]),
    my.query("SELECT daily_key, status FROM engine_runs WHERE run_scope = 'daily' AND is_active = 1 AND daily_key >= ?", [sinceKey]),
  ]);
  const fmtD = (x) => { const d = new Date(x); return `${d.getMonth() + 1}/${d.getDate()}`; };
  const aBy = {}; arts.forEach((r) => { aBy[fmtD(r.d)] = r.c; });
  const rBy = {}; reviews.forEach((r) => { rBy[fmtD(r.d)] = r.c; });
  const runBy = {}; dayRuns.forEach((r) => { runBy[r.daily_key] = runStatus(r.status); });
  const out = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const key = rc.getDailyKey(d);
    const k = `${d.getMonth() + 1}/${d.getDate()}`;
    out.push({ d: k, date: key, articles: aBy[k] || 0, review: rBy[k] || 0, runStatus: runBy[key] || null });
  }
  return out;
}

// ---------- 配置 ----------
async function configUI() {
  const [kw, src, docs] = await Promise.all([
    my.query('SELECT id, keyword, cluster, intent, priority, enabled FROM config_keywords ORDER BY priority, cluster, keyword'),
    my.query('SELECT id, name, group_name, type, enabled, url, site_url, query_text FROM config_sources ORDER BY group_name, name'),
    my.query('SELECT config_key, config_type, version, updated_by, updated_at FROM app_configs ORDER BY config_type, config_key'),
  ]);
  // 源健康度：看所有采集日志中该源的失败情况
  const logs = await my.query('SELECT source_name, status, COUNT(*) c FROM source_collection_logs GROUP BY source_name, status');
  const health = {};
  for (const l of logs) {
    const h = (health[l.source_name] = health[l.source_name] || { total: 0, failed: 0, partial: 0 });
    h.total += l.c;
    if (l.status === 'failed') h.failed += l.c;
    if (l.status === 'partial') h.partial += l.c;
  }
  const healthOf = (name, enabled) => {
    const h = health[name];
    if (!h || !h.total) return 'mut';
    if (h.failed >= 3 || h.failed === h.total) return 'bad';
    if (h.failed > 0 || h.partial > 0) return 'warn';
    return 'ok';
  };
  const KIND = { prompt: 'Prompt', schema: 'Schema', yaml_doc: 'Policy' };
  const HIGH_RISK = ['production_policy', 'internal_claims', 'models'];
  return {
    keywords: kw.map((k) => ({ id: k.id, word: k.keyword, group: k.cluster || '—', intent: k.intent, priority: k.priority, enabled: !!k.enabled })),
    sources: src.map((s) => ({
      id: s.id, name: s.name, group: s.group_name || '—', type: s.type || '—', enabled: !!s.enabled,
      health: healthOf(s.name, s.enabled),
      url: s.url || s.site_url || null, query: s.query_text || null, // 采集地址 / 搜索词
    })),
    policies: docs.map((d) => ({
      name: d.config_key, kind: KIND[d.config_type] || d.config_type, version: `v${d.version}`,
      updated: dt(d.updated_at), by: d.updated_by || '—',
      risk: d.config_type === 'prompt' || HIGH_RISK.includes(d.config_key),
    })),
  };
}

// ---------- Bootstrap ----------
async function uiBootstrap() {
  const dailyKey = rc.getDailyKey();
  const { activeRun } = await rc.getTodayRunStatus({ dailyKey });
  const decision = await rc.canStartDaily({ dailyKey, mode: 'start' });

  let steps = null; let meta = null; let todayTopics = 0;
  if (activeRun) {
    steps = await stepsForRun(activeRun);
    todayTopics = (await my.query('SELECT COUNT(*) c FROM topic_candidates WHERE engine_run_id = ?', [activeRun.id]))[0].c;
  }
  const [articles, runs, topicsRes, trend, config, readyCount, needsCount, todayReadyCount, needsHumanCount] = await Promise.all([
    listArticlesUI(), listRunsUI(), listTopicsUI(dailyKey), trend7d(), configUI(),
    my.query("SELECT COUNT(*) c FROM articles WHERE status = 'ready_for_review'"),
    my.query("SELECT COUNT(*) c FROM articles WHERE status = 'needs_fact_sources'"),
    my.query("SELECT COUNT(*) c FROM articles WHERE status = 'ready_for_review' AND created_at >= ?", [`${dailyKey} 00:00:00`]),
    // 待补来源文章里，存在「多轮无法自动补齐、需人工介入」表述的 —— 算人工待办，其余算系统自动处理中
    my.query("SELECT COUNT(DISTINCT a.id) c FROM articles a JOIN source_resolutions r ON r.article_id = a.id AND r.resolved_status = 'needs_manual_review' WHERE a.status = 'needs_fact_sources'"),
  ]);
  const state = todayState(activeRun, steps || []);
  // 持续失败的采集源（启用中但健康度 bad）
  const chronicSources = config.sources.filter((s) => s.enabled && s.health === 'bad').map((s) => s.name);
  const todayArticles = articles.filter((a) => a.createdDay === dailyKey);
  const needsHuman = needsHumanCount[0].c;
  const autoResolving = Math.max(0, needsCount[0].c - needsHuman);
  // 系统处理中：运行时的当前步骤
  const runningStep = state === 'running' && steps ? steps.find((s) => s.status === 'running') : null;
  return {
    ok: true, dailyKey,
    today: {
      state,
      run: activeRun ? {
        id: activeRun.id, status: runStatus(activeRun.status), mode: activeRun.run_mode,
        started: dt(activeRun.started_at), finished: dt(activeRun.finished_at),
        durMs: durMs(activeRun.started_at, activeRun.finished_at),
        error: activeRun.error_message || null,
      } : null,
      steps,
      meta: {
        items: activeRun ? activeRun.topics_collected || 0 : 0,
        topics: todayTopics,
        articles: activeRun ? activeRun.articles_generated || 0 : 0,
        review: todayReadyCount[0].c, // 仅统计今日产生的待终审，避免历史遗留混入今日摘要
      },
      availableActions: decision.availableActions,
      message: decision.reason,
      // 仅指向今日文章；今日没有就给 null（前端会回退到文章库），不能指到无关的历史文章
      firstArticleId: todayArticles[0] ? todayArticles[0].id : null,
    },
    counts: {
      readyForReview: readyCount[0].c,
      needsFactSources: needsCount[0].c,
      needsHumanSources: needsHuman,   // 待我处理：人工补来源
      autoResolving,                   // 系统处理中：自动补源
      runningStepKey: runningStep ? runningStep.key : null,
    },
    chronicSources,
    articles, runs, topics: topicsRes.topics, topicsScope: topicsRes.scope, trend, config,
    taxonomy: uiTaxonomy(),
    portfolio: await uiPortfolioSummary(),
  };
}

// 今日组合决策摘要（选题池页展示「为什么选这个/为什么没选那个」）
async function uiPortfolioSummary() {
  try {
    const deferred = await my.query("SELECT topic, raw_score, selection_score, selection_skip_reason, deferred_until FROM topic_candidates WHERE status = 'deferred' AND deferred_until > NOW(3) ORDER BY raw_score DESC LIMIT 8");
    const selected = await my.query("SELECT topic, raw_score, selection_score, business_category, topic_cluster FROM topic_candidates WHERE selection_status = 'selected' ORDER BY updated_at DESC LIMIT 3");
    return {
      deferredCount: (await my.query("SELECT COUNT(*) c FROM topic_candidates WHERE status = 'deferred' AND deferred_until > NOW(3)"))[0].c,
      deferred: deferred.map((d) => ({ topic: d.topic, rawScore: d.raw_score, selectionScore: d.selection_score, reason: d.selection_skip_reason, until: d.deferred_until ? dt(d.deferred_until) : null })),
      lastSelected: selected.map((s2) => ({ topic: s2.topic, rawScore: s2.raw_score, selectionScore: s2.selection_score, businessCategory: s2.business_category, topicCluster: s2.topic_cluster })),
    };
  } catch (_) {
    return { deferredCount: 0, deferred: [], lastSelected: [] };
  }
}

// ---------- 生产日报（按天聚合：日期胶囊条 + 单日全景）----------
// 归属规则：created_at 的本地日；run 优先用 daily_key。模拟数据必须回填时间戳（见 AGENTS.md 契约）。
async function uiDays(limit = 14) {
  const n = Math.max(3, Math.min(30, limit));
  const since = `${rc.getDailyKey(new Date(Date.now() - (n - 1) * 86400000))} 00:00:00`;
  const cnt = async (table) => Object.fromEntries(
    (await my.query(`SELECT DATE(created_at) d, COUNT(*) c FROM ${table} WHERE created_at >= ? GROUP BY DATE(created_at)`, [since]))
      .map((r) => [rc.getDailyKey(new Date(r.d)), r.c]));
  const [srcBy, topicBy, artBy, runRows, verdictRows, obsRows] = await Promise.all([
    cnt('source_items'), cnt('topic_candidates'), cnt('articles'),
    my.query("SELECT daily_key, status FROM engine_runs WHERE run_scope = 'daily' AND is_active = 1 AND daily_key >= ?", [since.slice(0, 10)]),
    my.query("SELECT DATE(created_at) d, COUNT(*) c FROM status_transitions WHERE entity_type = 'article' AND to_status IN ('ready_for_review','approved_for_publish','published') AND created_at >= ? GROUP BY DATE(created_at)", [since]),
    my.query('SELECT daily_key d, COUNT(*) c FROM source_observations WHERE daily_key >= ? GROUP BY daily_key', [since.slice(0, 10)]),
  ]);
  const runBy = {}; runRows.forEach((r) => { runBy[r.daily_key] = runStatus(r.status); });
  const verdictBy = {}; verdictRows.forEach((r) => { verdictBy[rc.getDailyKey(new Date(r.d))] = r.c; });
  const obsBy = {}; obsRows.forEach((r) => { obsBy[r.d] = r.c; }); // 每日采集真相优先用观察记录
  const days = [];
  for (let i = n - 1; i >= 0; i--) {
    const date = rc.getDailyKey(new Date(Date.now() - i * 86400000));
    days.push({
      date, runStatus: runBy[date] || null,
      sources: obsBy[date] != null ? obsBy[date] : (srcBy[date] || 0),
      topics: topicBy[date] || 0,
      articles: artBy[date] || 0, verdicts: verdictBy[date] || 0,
    });
  }
  return days;
}

// 主题的来源线索：source_urls_json → [{url, host}]，供前端展示可点的来源域名
function srcHosts(j) {
  const arr = my.asJson(j);
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 4).map((u) => {
    try { return { url: u, host: new URL(u).hostname.replace(/^www\./, '') }; }
    catch (_) { return { url: String(u), host: String(u).slice(0, 28) }; }
  });
}

async function uiDay(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const a = `${date} 00:00:00`;
  const b = `${date} 23:59:59.999`;
  const range = (col = 'created_at') => `${col} >= '${a.replace(/'/g, '')}' AND ${col} <= '${b.replace(/'/g, '')}'`;

  const [runs, srcStats, srcGroups, srcCats, srcTypes, srcFails, topicsNew, topicDecisions, articlesBorn, artTransitions, fcCount, versionsNew, channelsNew, warnEvents] = await Promise.all([
    my.query(`SELECT * FROM engine_runs WHERE daily_key = ? OR (${range('started_at')}) ORDER BY started_at`, [date]),
    my.query(`SELECT COUNT(*) c FROM source_items WHERE ${range()}`),
    my.query(`SELECT source_group k, COUNT(*) c FROM source_items WHERE ${range()} GROUP BY source_group ORDER BY c DESC`),
    my.query(`SELECT business_category k, COUNT(*) c FROM source_items WHERE ${range()} AND business_category IS NOT NULL GROUP BY business_category ORDER BY c DESC LIMIT 8`),
    my.query(`SELECT content_type k, COUNT(*) c FROM source_items WHERE ${range()} AND content_type IS NOT NULL GROUP BY content_type ORDER BY c DESC LIMIT 8`),
    my.query(`SELECT source_name, status, http_status, error_message FROM source_collection_logs WHERE ${range()} AND status IN ('failed','partial') ORDER BY status LIMIT 12`),
    my.query(`SELECT COUNT(*) c FROM topic_candidates WHERE ${range()}`).then(async (cnt) => ({
      count: cnt[0].c,
      rows: await my.query(`SELECT id, topic, score, raw_score, content_value_score, priority, status, business_category, topic_cluster, selection_status, selection_skip_reason, source_urls_json, created_at FROM topic_candidates WHERE ${range()} ORDER BY score DESC LIMIT 60`),
    })),
    my.query(`SELECT st.entity_id, st.to_status, st.reason, st.created_at, tc.topic, tc.raw_score, tc.content_value_score, tc.selection_score, tc.business_category, tc.topic_cluster, tc.source_urls_json
              FROM status_transitions st LEFT JOIN topic_candidates tc ON tc.id = st.entity_id
              WHERE st.entity_type = 'topic_candidate' AND st.to_status IN ('selected','deferred') AND ${range('st.created_at')} ORDER BY st.created_at LIMIT 40`),
    my.query(`SELECT id, title, slug, status, quality_score, article_quality_score, seo_score, geo_score, fact_publish_readiness, business_category, topic_cluster, created_at FROM articles WHERE ${range()} ORDER BY created_at`),
    my.query(`SELECT st.entity_id, st.from_status, st.to_status, st.reason, st.actor, st.created_at, a.title, DATE(a.created_at) born
              FROM status_transitions st LEFT JOIN articles a ON a.id = st.entity_id
              WHERE st.entity_type = 'article' AND ${range('st.created_at')} ORDER BY st.created_at LIMIT 60`),
    my.query(`SELECT COUNT(*) c FROM fact_checks WHERE ${range()}`),
    my.query(`SELECT v.article_id, v.version_label, v.generation_mode, v.created_at, a.title FROM article_versions v LEFT JOIN articles a ON a.id = v.article_id WHERE ${range('v.created_at')} ORDER BY v.created_at LIMIT 20`),
    my.query(`SELECT co.article_id, co.channel, co.status, a.title FROM channel_outputs co LEFT JOIN articles a ON a.id = co.article_id WHERE ${range('co.created_at')} ORDER BY co.created_at LIMIT 20`),
    my.query(`SELECT event_type, level, message, created_at FROM workflow_events WHERE ${range()} AND level IN ('warning','error') ORDER BY created_at LIMIT 25`),
  ]);

  // 每日采集真相：source_observations 优先（canonical 化后 source_items 不再按天重复插入）
  const [obsStatus, obsGroups, obsCats, obsTypes, dayRepRows] = await Promise.all([
    my.query('SELECT observation_status k, COUNT(*) c FROM source_observations WHERE daily_key = ? GROUP BY observation_status', [date]),
    my.query('SELECT source_group k, COUNT(*) c FROM source_observations WHERE daily_key = ? GROUP BY source_group ORDER BY c DESC', [date]),
    my.query('SELECT s.business_category k, COUNT(*) c FROM source_observations o LEFT JOIN source_items s ON s.id = o.source_item_id WHERE o.daily_key = ? AND s.business_category IS NOT NULL GROUP BY s.business_category ORDER BY c DESC LIMIT 8', [date]),
    my.query('SELECT s.content_type k, COUNT(*) c FROM source_observations o LEFT JOIN source_items s ON s.id = o.source_item_id WHERE o.daily_key = ? AND s.content_type IS NOT NULL GROUP BY s.content_type ORDER BY c DESC LIMIT 8', [date]),
    my.query('SELECT report_json FROM engine_reports WHERE DATE(created_at) = ? ORDER BY created_at DESC LIMIT 1', [date]),
  ]);
  const obsTotal = obsStatus.reduce((a, r) => a + r.c, 0);
  const dayRep = dayRepRows[0] ? my.asJson(dayRepRows[0].report_json) || {} : null;

  // 拍板：当日文章状态终局变化
  const VERDICT_STATUS = ['ready_for_review', 'needs_quality_revision', 'approved_for_publish', 'published', 'rejected', 'fact_check_failed'];
  const verdicts = artTransitions.filter((t) => VERDICT_STATUS.includes(t.to_status)).map((t) => ({
    articleId: t.entity_id, title: t.title || t.entity_id, to: t.to_status, reason: t.reason || '',
    t: dt(t.created_at), bornDay: t.born ? rc.getDailyKey(new Date(t.born)) : null,
  }));

  // 当日推进的存量文章（非当天生成）
  const bornIds = new Set(articlesBorn.map((x) => x.id));
  const advanced = {};
  for (const t of artTransitions) {
    if (bornIds.has(t.entity_id)) continue;
    if (!advanced[t.entity_id]) advanced[t.entity_id] = { articleId: t.entity_id, title: t.title || t.entity_id, bornDay: t.born ? rc.getDailyKey(new Date(t.born)) : null, moves: [] };
    advanced[t.entity_id].moves.push({ from: t.from_status, to: t.to_status, reason: (t.reason || '').slice(0, 120), t: dt(t.created_at) });
  }

  // 选题决策汇总
  const selected = topicDecisions.filter((d) => d.to_status === 'selected');
  const deferred = topicDecisions.filter((d) => d.to_status === 'deferred');
  const deferReasons = {};
  deferred.forEach((d) => {
    const key = (d.reason || '').includes('cluster') || (d.reason || '').includes('主题簇') ? '主题簇饱和'
      : (d.reason || '').includes('category') || (d.reason || '').includes('分类') ? '业务分类饱和'
      : (d.reason || '').includes('keyword') || (d.reason || '').includes('关键词') ? '关键词近期已用'
      : (d.reason || '').includes('来源') ? '来源支撑不足' : '语义重复/其他';
    deferReasons[key] = (deferReasons[key] || 0) + 1;
  });

  // 当日代表 run（优先 active daily）的 7 步执行状态，用于倒排流水线视图
  const dayRunRow = runs.find((r) => r.run_scope === 'daily' && r.is_active)
    || runs.find((r) => r.run_scope === 'daily')
    || runs[runs.length - 1] || null;
  const steps = dayRunRow ? await stepsForRun(dayRunRow) : [];

  return {
    date,
    dayRunId: dayRunRow ? dayRunRow.id : null,
    steps,
    runs: runs.map((r) => ({
      id: r.id, scope: r.run_scope, mode: r.run_mode, status: r.is_active ? runStatus(r.status) : 'superseded',
      runner: (my.asJson(r.summary_json) || {}).runner || null,
      started: dt(r.started_at), finished: dt(r.finished_at), durMs: durMs(r.started_at, r.finished_at),
      articles: r.articles_generated || 0, error: r.error_message || null,
    })),
    collect: obsTotal > 0 ? {
      total: obsTotal, basis: 'observations',
      observed: Object.fromEntries(obsStatus.map((r) => [r.k, r.c])),
      byGroup: Object.fromEntries(obsGroups.filter((g) => g.k).map((g) => [g.k, g.c])),
      byCategory: Object.fromEntries(obsCats.map((g) => [g.k, g.c])),
      byType: Object.fromEntries(obsTypes.map((g) => [g.k, g.c])),
      failures: srcFails.map((f) => ({ name: f.source_name, status: f.status, http: f.http_status, error: (f.error_message || '').slice(0, 80) })),
    } : {
      total: srcStats[0].c, basis: 'items', observed: null,
      byGroup: Object.fromEntries(srcGroups.filter((g) => g.k).map((g) => [g.k, g.c])),
      byCategory: Object.fromEntries(srcCats.map((g) => [g.k, g.c])),
      byType: Object.fromEntries(srcTypes.map((g) => [g.k, g.c])),
      failures: srcFails.map((f) => ({ name: f.source_name, status: f.status, http: f.http_status, error: (f.error_message || '').slice(0, 80) })),
    },
    sourceReport: dayRep ? { coverage: dayRep.sourceObservationCoverage || null, lanes: dayRep.sourceLanes || null } : null,
    topics: {
      created: topicsNew.count,
      top: topicsNew.rows.slice(0, 10).map((t) => ({
        id: t.id, topic: t.topic, score: t.score, value: t.content_value_score, priority: t.priority,
        status: t.status, businessCategory: t.business_category, topicCluster: t.topic_cluster,
        skipReason: t.selection_skip_reason, sources: srcHosts(t.source_urls_json),
        t: dt(t.created_at), // 生成时刻：区分同日多批次
      })),
      selected: selected.map((d) => ({ topic: d.topic || d.entity_id, raw: d.raw_score, value: d.content_value_score, selection: d.selection_score, businessCategory: d.business_category, t: dt(d.created_at), sources: srcHosts(d.source_urls_json) })),
      deferredCount: deferred.length,
      deferReasons,
      deferredSample: deferred.slice(0, 6).map((d) => ({ topic: (d.topic || d.entity_id || '').slice(0, 50), raw: d.raw_score, reason: (d.reason || '').slice(0, 70) })),
    },
    articlesBorn: articlesBorn.map((x) => ({
      id: x.id, title: x.title, slug: x.slug, status: x.status,
      quality: x.quality_score, articleQuality: x.article_quality_score,
      seo: x.seo_score, geo: x.geo_score, ...factMeta(x.fact_publish_readiness),
      businessCategory: x.business_category, topicCluster: x.topic_cluster, created: dt(x.created_at),
    })),
    advancedArticles: Object.values(advanced),
    factChecks: fcCount[0].c,
    versionsNew: versionsNew.map((v) => ({ articleId: v.article_id, title: (v.title || '').slice(0, 40), label: v.version_label, mode: v.generation_mode, t: dt(v.created_at) })),
    channelsNew: channelsNew.map((c) => ({ articleId: c.article_id, title: (c.title || '').slice(0, 30), channel: CHANNEL_KEY[c.channel] || c.channel, status: chStatus(c.status) })),
    verdicts,
    timeline: artTransitions.map((t) => ({
      t: dt(t.created_at), kind: 'transition', entityId: t.entity_id,
      title: (t.title || '').slice(0, 36), from: t.from_status, to: t.to_status,
      reason: (t.reason || '').slice(0, 110), actor: t.actor || '系统', bornDay: t.born ? rc.getDailyKey(new Date(t.born)) : null,
    })),
    warnings: warnEvents.map((e) => ({ t: dt(e.created_at), level: e.level, type: e.event_type, message: (e.message || '').slice(0, 130) })),
  };
}

// 标题里的 HTML 实体解码（RSS 采集常见 &#x7F8E; 形式）
function deEnt(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
}

// 当日采集明细：按来源分组的条目列表（日报内嵌浏览，不跳页）
// 优先 source_observations（每日采集真相）；无观察记录的历史日回退 source_items.created_at
async function uiDaySources(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const a = `${date} 00:00:00`;
  const b = `${date} 23:59:59.999`;
  const [obsRows, logs] = await Promise.all([
    my.query('SELECT source_name, source_group, source_lane, canonical_url, source_url, title, observation_status, created_at FROM source_observations WHERE daily_key = ? ORDER BY source_name, created_at LIMIT 600', [date]),
    my.query('SELECT source_name, status, http_status, error_message FROM source_collection_logs WHERE created_at >= ? AND created_at <= ?', [a, b]),
  ]);
  const basis = obsRows.length > 0 ? 'observations' : 'items';
  const rows = obsRows.length > 0 ? obsRows
    : await my.query('SELECT source_name, source_group, source_url, title, business_category, content_type, created_at FROM source_items WHERE created_at >= ? AND created_at <= ? ORDER BY source_name, created_at LIMIT 600', [a, b]);
  const logBy = {};
  logs.forEach((l) => { logBy[l.source_name] = { status: l.status, http: l.http_status, error: (l.error_message || '').slice(0, 80) }; });
  const groups = {};
  for (const r of rows) {
    const k = r.source_name || '未知来源';
    if (!groups[k]) groups[k] = { name: k, group: r.source_group, count: 0, items: [] };
    groups[k].count++;
    if (groups[k].items.length < 50) {
      groups[k].items.push({
        title: deEnt(r.title).slice(0, 90) || '(无标题)', url: r.source_url || r.canonical_url,
        category: r.business_category || null, type: r.content_type || null,
        lane: r.source_lane || null, obsStatus: r.observation_status || null,
        t: dt(r.created_at),
      });
    }
  }
  // 采集失败、0 条入库的来源也要出现在列表里
  for (const [name, l] of Object.entries(logBy)) {
    if (l.status !== 'success' && !groups[name]) groups[name] = { name, group: null, count: 0, items: [] };
  }
  const sources = Object.values(groups).map((g) => ({ ...g, log: logBy[g.name] || null }))
    .sort((x, y) => y.count - x.count);
  return { date, basis, total: rows.length, truncated: rows.length >= 600, sources };
}

// ---------- 数据源（canonical 素材库 + 观察记录）----------
// source_items 是 canonical 素材表（同一 URL 不重复插入）；每日采集真相在 source_observations。

const LANE_KEYS = ['news', 'policy', 'knowledge'];

// 数据源总览：最近一次 engine_report 的覆盖统计 + canonical 各线计数
async function uiSourcesOverview() {
  const [repRows, laneRows] = await Promise.all([
    my.query('SELECT report_json, created_at FROM engine_reports ORDER BY created_at DESC LIMIT 1'),
    my.query('SELECT lane, usage_status, COUNT(*) c FROM source_canonical_items GROUP BY lane, usage_status'),
  ]);
  const j = repRows[0] ? my.asJson(repRows[0].report_json) || {} : {};
  const laneCounts = {};
  let canonicalTotal = 0;
  for (const r of laneRows) {
    const lane = r.lane || 'unknown';
    if (!laneCounts[lane]) laneCounts[lane] = { total: 0, byStatus: {} };
    laneCounts[lane].total += r.c;
    laneCounts[lane].byStatus[r.usage_status || 'unknown'] = r.c;
    canonicalTotal += r.c;
  }
  return {
    coverage: j.sourceObservationCoverage || null,
    lanes: j.sourceLanes || null,
    reportAt: repRows[0] ? dt(repRows[0].created_at) : null,
    laneCounts, canonicalTotal,
  };
}

// canonical 素材列表（lane / usage_status / 来源 过滤，join source_items 拿展示字段）
async function uiCanonicalSources({ lane, status, source, limit = 120 } = {}) {
  const where = [];
  const args = [];
  if (lane && LANE_KEYS.includes(lane)) { where.push('c.lane = ?'); args.push(lane); }
  if (status) { where.push('c.usage_status = ?'); args.push(String(status).slice(0, 30)); }
  // 来源下拉的可选项：在 lane/status 条件下聚合（不含 source 自身条件，便于切换）
  const facetCond = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const sourceFacet = await my.query(
    `SELECT s.source_name k, COUNT(*) c FROM source_canonical_items c
     LEFT JOIN source_items s ON s.id = c.source_item_id
     ${facetCond} GROUP BY s.source_name ORDER BY c DESC LIMIT 60`, [...args]);
  if (source) { where.push('s.source_name = ?'); args.push(String(source).slice(0, 80)); }
  const rows = await my.query(
    `SELECT c.canonical_url_hash, c.canonical_url, c.source_item_id, c.first_seen_at, c.last_seen_at,
            c.seen_count, c.source_count, c.lane, c.usage_status, c.used_at, c.used_by_article_id,
            c.times_in_prompt, c.reactivated_at,
            s.source_name, s.source_group, s.title, s.source_url, s.summary
     FROM source_canonical_items c
     LEFT JOIN source_items s ON s.id = c.source_item_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY c.last_seen_at DESC LIMIT ${Math.min(300, Math.max(1, limit))}`, args);
  const items = rows.map((r) => ({
    hash: r.canonical_url_hash, url: r.source_url || r.canonical_url, itemId: r.source_item_id,
    lane: r.lane, usageStatus: r.usage_status,
    firstSeen: dt(r.first_seen_at), lastSeen: dt(r.last_seen_at),
    seenCount: r.seen_count, sourceCount: r.source_count,
    timesInPrompt: r.times_in_prompt, reactivatedAt: dt(r.reactivated_at),
    usedAt: dt(r.used_at), usedByArticleId: r.used_by_article_id,
    sourceName: r.source_name, sourceGroup: r.source_group,
    title: deEnt(r.title).slice(0, 110) || '(无标题)', summary: deEnt(r.summary).slice(0, 160),
  }));
  // 每个来源的素材总数直接数 source_items（canonical 素材表本体）；
  // source_canonical_items 是去重索引，可能滞后于最新采集，不能当素材计数用
  const itemFacet = await my.query('SELECT source_name k, COUNT(*) c FROM source_items GROUP BY source_name');
  return {
    items,
    sourceFacet: sourceFacet.filter((f) => f.k).map((f) => ({ name: f.k, count: f.c })),
    itemCounts: Object.fromEntries(itemFacet.filter((f) => f.k).map((f) => [f.k, f.c])),
    itemTotal: itemFacet.reduce((a, f) => a + f.c, 0),
  };
}

// 观察记录（每日采集真相），按 daily_key / engine_run_id / observation_status 过滤
async function uiObservations({ date, runId, status, limit = 200 } = {}) {
  const where = [];
  const args = [];
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) { where.push('daily_key = ?'); args.push(date); }
  if (runId) { where.push('engine_run_id = ?'); args.push(String(runId).slice(0, 80)); }
  if (status) { where.push('observation_status = ?'); args.push(String(status).slice(0, 40)); }
  const cond = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const [rows, statRows] = await Promise.all([
    my.query(
      `SELECT id, engine_run_id, daily_key, source_item_id, source_name, source_group, source_lane,
              title, canonical_url, observation_status, duplicate_reason, created_at
       FROM source_observations ${cond} ORDER BY created_at DESC LIMIT ${Math.min(500, Math.max(1, limit))}`, args),
    my.query(`SELECT observation_status k, COUNT(*) c FROM source_observations ${cond} GROUP BY observation_status`, args),
  ]);
  return {
    byStatus: Object.fromEntries(statRows.map((r) => [r.k, r.c])),
    items: rows.map((r) => ({
      id: r.id, runId: r.engine_run_id, day: r.daily_key, itemId: r.source_item_id,
      sourceName: r.source_name, sourceGroup: r.source_group, lane: r.source_lane,
      title: deEnt(r.title).slice(0, 110) || '(无标题)', url: r.canonical_url,
      status: r.observation_status, dupReason: (r.duplicate_reason || '').slice(0, 120),
      t: dt(r.created_at),
    })),
  };
}

// ---------- 模型调用 I/O（调试台：每一步 AI 进了什么、出了什么）----------
// Viewer 只绑 127.0.0.1，本地调试台放开 prompt/raw_response 全文。

async function uiModelRuns({ taskType, runId, articleId, limit = 50 } = {}) {
  const where = [];
  const args = [];
  if (taskType) { where.push('task_type = ?'); args.push(String(taskType).slice(0, 50)); }
  if (runId) { where.push('engine_run_id = ?'); args.push(String(runId).slice(0, 80)); }
  if (articleId) { where.push('article_id = ?'); args.push(String(articleId).slice(0, 80)); }
  const cond = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const [rows, types] = await Promise.all([
    my.query(`SELECT id, engine_run_id, article_id, task_type, model_provider, model_name, status,
                     started_at, finished_at, error_message,
                     CHAR_LENGTH(task_prompt) prompt_len, CHAR_LENGTH(raw_response) response_len
              FROM model_runs ${cond} ORDER BY started_at DESC LIMIT ${Math.min(200, Math.max(1, limit))}`, args),
    my.query('SELECT task_type k, COUNT(*) c FROM model_runs GROUP BY task_type ORDER BY c DESC'),
  ]);
  return {
    byType: Object.fromEntries(types.map((t) => [t.k, t.c])),
    items: rows.map((r) => ({
      id: r.id, runId: r.engine_run_id, articleId: r.article_id, taskType: r.task_type,
      provider: r.model_provider, model: r.model_name, status: r.status,
      started: dt(r.started_at), durMs: durMs(r.started_at, r.finished_at),
      error: (r.error_message || '').slice(0, 160) || null,
      promptLen: r.prompt_len || 0, responseLen: r.response_len || 0,
    })),
  };
}

async function uiModelRun(id) {
  const r = (await my.query('SELECT * FROM model_runs WHERE id = ?', [id]))[0];
  if (!r) return null;
  return {
    id: r.id, runId: r.engine_run_id, articleId: r.article_id, taskType: r.task_type,
    provider: r.model_provider, model: r.model_name, status: r.status,
    started: dt(r.started_at), finished: dt(r.finished_at), durMs: durMs(r.started_at, r.finished_at),
    error: r.error_message || null,
    prompt: r.task_prompt || '', response: r.raw_response || '',
    parsed: my.asJson(r.parsed_output_json),
  };
}

// ---------- 提示词/Schema 在线编辑 ----------
// 运行时 prompt 从 app_configs 读（config_lib），文件只是 seed；
// updated_by != 'file-sync' 时 config:sync 不会覆盖（要回到文件版本用 --force）。
async function saveConfigDoc(key, content, actor = 'web') {
  if (typeof content !== 'string' || !content.trim()) return { code: 400, data: { ok: false, error: '内容不能为空' } };
  const row = (await my.query('SELECT config_key, config_type, version FROM app_configs WHERE config_key = ?', [key]))[0];
  if (!row) return { code: 404, data: { ok: false, error: '未找到配置文档' } };
  if (row.config_type === 'schema') {
    try { JSON.parse(content); } catch (e) { return { code: 400, data: { ok: false, error: `Schema 必须是合法 JSON：${e.message}` } }; }
  }
  const sha = require('crypto').createHash('sha256').update(content).digest('hex');
  await my.update('app_configs', { content, content_sha256: sha, version: row.version + 1, updated_by: actor, updated_at: my.now() }, 'config_key = ?', [key]);
  return { code: 200, data: { ok: true, key, version: row.version + 1, note: '下一次任务启动即生效；config:sync 不会覆盖 Web 修改（恢复文件版本用 config:sync --force）' } };
}

// ---------- Topic Audition（选题压力测试结果，只读）----------
async function uiAuditions(limit = 10) {
  const rows = await my.query(`SELECT id, rounds, limit_per_round, status, summary_json, created_at FROM topic_audition_runs ORDER BY created_at DESC LIMIT ${Math.min(50, limit)}`);
  return rows.map((r) => {
    const s = my.asJson(r.summary_json) || {};
    return {
      id: r.id, rounds: r.rounds, limitPerRound: r.limit_per_round, status: r.status, created: dt(r.created_at),
      totalSelected: s.totalSelected, categoriesCovered: s.categoriesCovered, alexaListingShare: s.alexaListingShare,
      avgContentValueScore: s.avgContentValueScore, repetitionRisk: s.repetitionRisk, readyVerdict: s.readyVerdict,
    };
  });
}

async function uiAudition(id) {
  const run = (await my.query('SELECT * FROM topic_audition_runs WHERE id = ?', [id]))[0];
  if (!run) return null;
  const items = await my.query('SELECT round_no, topic, business_category, topic_cluster, content_type, raw_score, content_value_score, selection_score, decision, decision_reason FROM topic_audition_items WHERE audition_run_id = ? ORDER BY round_no, decision', [id]);
  return {
    id: run.id, rounds: run.rounds, limitPerRound: run.limit_per_round, status: run.status, created: dt(run.created_at),
    summary: my.asJson(run.summary_json), policy: my.asJson(run.policy_json),
    items: items.map((i) => ({
      round: i.round_no, topic: i.topic, businessCategory: i.business_category, topicCluster: i.topic_cluster,
      contentType: i.content_type, rawScore: i.raw_score, contentValueScore: i.content_value_score,
      selectionScore: i.selection_score, decision: i.decision, reason: i.decision_reason,
    })),
  };
}

// 分类体系（中文标签，供前端筛选与展示）
function uiTaxonomy() {
  try {
    const tax = require('./taxonomy_lib');
    const t = tax.loadTaxonomy();
    const map = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.label_zh || k]));
    return {
      contentTypes: map(t.content_types),
      businessCategories: map(t.business_categories),
      topicClusters: map(t.topic_clusters),
    };
  } catch (_) {
    return { contentTypes: {}, businessCategories: {}, topicClusters: {} };
  }
}

// ---------- 文章详情 ----------
const STRATEGY_ZH = { initial: '初稿', revision: '修订版', source_revision: '来源修订版', balanced: '均衡策略' };

async function uiArticle(id) {
  const a = (await my.query('SELECT * FROM articles WHERE id = ? OR slug = ?', [id, id]))[0];
  if (!a) return null;
  const [versions, factChecks, resolutions, channels, transitions, topic, reviewActs] = await Promise.all([
    my.query('SELECT * FROM article_versions WHERE article_id = ? ORDER BY created_at', [a.id]),
    my.query('SELECT * FROM fact_checks WHERE article_id = ? ORDER BY created_at', [a.id]),
    my.query('SELECT * FROM source_resolutions WHERE article_id = ? ORDER BY created_at DESC LIMIT 50', [a.id]),
    my.query('SELECT * FROM channel_outputs WHERE article_id = ? ORDER BY created_at', [a.id]),
    my.query("SELECT * FROM status_transitions WHERE entity_type = 'article' AND entity_id = ? ORDER BY created_at", [a.id]),
    a.topic_candidate_id ? my.query('SELECT score, priority FROM topic_candidates WHERE id = ?', [a.topic_candidate_id]) : Promise.resolve([]),
    my.query("SELECT * FROM review_actions WHERE article_id = ? AND dry_run = 0 ORDER BY created_at DESC", [a.id]),
  ]);
  const clsRow = (await my.query("SELECT content_type, business_category, topic_cluster, confidence, reason, classifier_type, created_at FROM content_classifications WHERE entity_type = 'articles' AND entity_id = ? ORDER BY created_at DESC LIMIT 1", [a.id]))[0];
  const aqRow = (await my.query('SELECT * FROM article_quality_scores WHERE article_id = ? ORDER BY created_at DESC LIMIT 1', [a.id]))[0];
  const verIds = versions.map((v) => v.id);
  const modelRuns = await my.query(
    `SELECT task_type, model_name, status, started_at, finished_at,
            CHAR_LENGTH(task_prompt) pin, CHAR_LENGTH(raw_response) pout, error_message
     FROM model_runs WHERE article_id = ? ${verIds.length ? `OR article_version_id IN (${verIds.map(() => '?').join(',')})` : ''}
     ORDER BY started_at`, [a.id, ...verIds]);

  // 取最新有评分 JSON 的版本
  const latest = versions[versions.length - 1] || {};
  const latestWith = (field) => { for (let i = versions.length - 1; i >= 0; i--) { const j = my.asJson(versions[i][field]); if (j) return j; } return null; };
  const quality = latestWith('quality_json');
  const seoJson = latestWith('seo_score_json');
  const geoJson = latestWith('geo_score_json');

  const overall = (await my.query('SELECT overall_score FROM seo_geo_scores WHERE article_id = ? ORDER BY created_at DESC LIMIT 1', [a.id]))[0];

  // 版本列表（倒序，最新在前）
  const verList = versions.map((v, i) => ({
    label: v.version_label || `v${i + 1}`,
    strategy: STRATEGY_ZH[v.strategy] || STRATEGY_ZH[v.generation_mode] || v.strategy || v.generation_mode || '初稿',
    current: v.id === a.current_version_id || i === versions.length - 1,
    body: v.article_markdown || '',
    created: dt(v.created_at),
    words: (v.article_markdown || '').length,
  })).reverse();
  // 仅一个 current
  const curIdx = verList.findIndex((v) => v.current);
  verList.forEach((v, i) => { v.current = i === (curIdx === -1 ? 0 : curIdx); });

  // 事实核查轮次
  const factRounds = factChecks.map((f, i) => ({
    v: `v${i + 1}`, total: f.claims_count || 0, high: f.high_risk_count || 0, must: f.must_fix_count || 0,
    ready: ['ready', 'ready_after_minor_edits'].includes(f.publish_readiness),
    note: `${{ ready: '发布就绪。', ready_after_minor_edits: '微调后可发。', needs_fact_sources: '仍需补充权威来源。', not_ready: '尚未达到发布标准。' }[f.publish_readiness] || ''}整体风险 ${{ low: '低', medium: '中', high: '高' }[f.overall_risk] || f.overall_risk || '—'}；${f.must_fix_count || 0} 条必修${f.high_risk_count ? `，${f.high_risk_count} 条高风险` : ''}。`,
    at: dt(f.created_at),
  }));

  // 来源补全（按 claim 去重，保留最新一条）
  const seenClaims = new Set();
  const RES_STATUS = { resolved: 'resolved', partially_resolved: 'resolving', needs_manual_review: 'needs_human' };
  const sources = [];
  for (const r of resolutions) {
    const k = (r.claim_text || '').slice(0, 80);
    if (seenClaims.has(k)) continue;
    seenClaims.add(k);
    sources.push({
      claim: r.claim_text,
      found: r.source_title ? `${r.source_name ? r.source_name + ' · ' : ''}${r.source_title}` : '—',
      url: r.source_url || null,
      suggest: r.suggested_rewrite || r.evidence_summary || r.notes || '—',
      status: RES_STATUS[r.resolved_status] || 'resolving',
    });
  }

  // 渠道稿
  const chOrder = ['wechat', 'douyin', 'xiaohongshu'];
  const chRows = chOrder.map((ch) => {
    const rows = channels.filter((c) => c.channel === ch);
    const c = rows[rows.length - 1];
    if (!c) return { ch: CHANNEL_KEY[ch], name: CHANNEL_NAME[ch], status: 'pending', words: 0, title: '', body: '' };
    return {
      ch: CHANNEL_KEY[ch], name: CHANNEL_NAME[ch], status: chStatus(c.status),
      words: (c.content_markdown || '').length, title: c.title || '', body: c.content_markdown || '',
      error: chStatus(c.status) === 'fail' ? '渠道稿生成或校验失败' : undefined,
    };
  });

  // SEO/GEO
  const seoItems = mapDims(SEO_DIMS, seoJson && seoJson.breakdown);
  const geoItems = mapDims(GEO_DIMS, geoJson && geoJson.breakdown);
  const seoDeduct = [...((seoJson && seoJson.issues) || []), ...((geoJson && geoJson.issues) || [])].slice(0, 8);
  let seoSkip = null;
  if (!seoItems.length) {
    seoSkip = { rejected: '文章已被打回，未进行 SEO/GEO 评分。', archived: '文章已归档，未进行 SEO/GEO 评分。' }[a.status]
      || '文章尚未就绪（需先通过事实核查），跳过 SEO/GEO 评分。';
  }

  // 打回信息
  const rejected = reviewActs.find((r) => r.after_status === 'rejected');

  // 自动补源进行中提示
  const sourceAuto = a.status === 'needs_fact_sources' && factRounds.length ? {
    round: Math.min(factRounds.length, 3), max: 3,
    note: `已完成 ${factRounds.length} 轮核查；系统会自动尝试补齐权威来源，多轮仍无法补齐的表述将转人工处理。`,
  } : null;

  const histExtras = reviewActs.map((r) => ({
    t: dt(r.created_at), actor: r.actor === 'cli' ? '审核人' : (r.actor || '审核人'),
    from: r.before_status, to: r.after_status, reason: r.note || '人工终审标记',
  }));
  const history = [
    ...transitions.map((t) => ({ t: dt(t.created_at), actor: t.actor === 'system' || !t.actor ? '系统' : t.actor, from: t.from_status || '—', to: t.to_status, reason: t.reason || '' })),
  ].sort((x, y) => (x.t || '').localeCompare(y.t || ''));

  return {
    id: a.id, slug: a.slug, title: a.title, status: a.status,
    quality: a.quality_score || 0, seo: a.seo_score || 0, geo: a.geo_score || 0,
    overall: overall ? overall.overall_score || 0 : 0,
    ...factMeta(a.fact_publish_readiness),
    contentType: a.content_type, businessCategory: a.business_category, topicCluster: a.topic_cluster,
    articleQualityScore: a.article_quality_score ?? null,
    articleQuality: aqRow ? {
      score: aqRow.article_quality_score, recommendation: aqRow.recommendation,
      breakdown: [
        ['卖家痛点契合', aqRow.seller_pain_fit, 20], ['可执行性', aqRow.actionability, 20], ['信息增量', aqRow.information_gain, 20],
        ['原创性', aqRow.originality, 10], ['结构清晰', aqRow.clarity, 10], ['证据使用', aqRow.evidence_use, 10], ['Flyfus 价值', aqRow.business_usefulness, 10],
      ],
      strengths: (my.asJson(aqRow.raw_json) || {}).strengths || [],
      issues: (my.asJson(aqRow.raw_json) || {}).issues || [],
      mustFix: (my.asJson(aqRow.raw_json) || {}).mustFix || [],
      at: dt(aqRow.created_at),
    } : null,
    visualPlan: my.asJson(latest.visual_plan_json) || (my.asJson(latest.article_json) || {}).visualPlan || [],
    classification: clsRow ? {
      confidence: clsRow.confidence != null ? Number(clsRow.confidence) : null,
      reason: clsRow.reason || null,
      classifierType: clsRow.classifier_type || null,
      at: dt(clsRow.created_at),
    } : null,
    words: (latest.article_markdown || '').length,
    created: dt(a.created_at), updated: dt(a.updated_at),
    topicScore: topic[0] ? topic[0].score : null, priority: topic[0] ? topic[0].priority : '—',
    channels: Object.fromEntries(chRows.map((c) => [c.ch, c.status === 'fail' ? 'fail' : c.status])),
    versions: verList.length ? verList : [{ label: 'v1', strategy: '初稿', current: true, body: '', created: dt(a.created_at), words: 0 }],
    qualityDims: mapDims(QUALITY_DIMS, quality && quality.breakdown),
    qualityVerdict: (quality && quality.publishRecommendation) || a.publish_recommendation || 'revise',
    qualityIssues: [
      ...(((quality && quality.requiredFixes) || []).map((t) => ({ level: 'bad', text: t }))),
      ...(((quality && quality.issues) || []).map((t) => ({ level: 'warn', text: t }))),
    ],
    factRounds, sources, sourceAuto,
    channelOutputs: chRows,
    seoItems, geoItems, seoDeduct, seoSkip,
    history,
    modelRuns: modelRuns.map((m) => ({
      task: m.task_type, model: m.model_name || '—', status: m.status,
      dur: m.started_at && m.finished_at ? ((new Date(m.finished_at) - new Date(m.started_at)) / 1000).toFixed(1) + 's' : '—',
      pin: m.pin || 0, pout: m.pout || 0, error: m.error_message ? String(m.error_message).slice(0, 120) : null,
    })),
    rejectReason: rejected ? '人工打回' : null,
    rejectBy: rejected ? (rejected.actor === 'cli' ? '审核人' : rejected.actor) : null,
    rejectAt: rejected ? dt(rejected.created_at) : null,
    rejectNote: rejected ? (rejected.note || '') : null,
  };
}

// ---------- 运行详情 ----------
async function uiRun(idOrKey) {
  let run = (await my.query('SELECT * FROM engine_runs WHERE id = ?', [idOrKey]))[0];
  if (!run) {
    run = (await my.query("SELECT * FROM engine_runs WHERE daily_key = ? AND run_scope = 'daily' ORDER BY is_active DESC, started_at DESC LIMIT 1", [idOrKey]))[0];
  }
  if (!run) return null;
  const steps = await stepsForRun(run);
  const srcRows = await my.query('SELECT * FROM source_collection_logs WHERE engine_run_id = ? ORDER BY FIELD(status, "failed", "partial", "success", "skipped"), source_group, source_name LIMIT 300', [run.id]);
  // 跨 run 统计该源累计失败次数，标记持续失败
  const failCounts = {};
  (await my.query("SELECT source_name, COUNT(*) c FROM source_collection_logs WHERE status = 'failed' GROUP BY source_name")).forEach((r) => { failCounts[r.source_name] = r.c; });
  const actions = await my.query('SELECT action, actor, trigger_source, status, error_message, created_at FROM run_actions WHERE engine_run_id = ? OR daily_key = ? ORDER BY created_at DESC LIMIT 30', [run.id, run.daily_key]);
  // 本次运行采集内容的分类统计
  const srcClsRows = await my.query('SELECT content_type, business_category, COUNT(*) c FROM source_items WHERE engine_run_id = ? GROUP BY content_type, business_category', [run.id]);
  const sourceClassification = { byContentType: {}, byBusinessCategory: {}, unclassified: 0 };
  for (const r of srcClsRows) {
    if (!r.content_type && !r.business_category) { sourceClassification.unclassified += r.c; continue; }
    if (r.content_type) sourceClassification.byContentType[r.content_type] = (sourceClassification.byContentType[r.content_type] || 0) + r.c;
    if (r.business_category) sourceClassification.byBusinessCategory[r.business_category] = (sourceClassification.byBusinessCategory[r.business_category] || 0) + r.c;
  }
  const failedModelRuns = await my.query("SELECT task_type, model_name, error_message, started_at FROM model_runs WHERE engine_run_id = ? AND status = 'failed' ORDER BY started_at DESC LIMIT 20", [run.id]);
  const transitions = await my.query('SELECT entity_type, entity_id, from_status, to_status, reason, actor, created_at FROM status_transitions WHERE engine_run_id = ? ORDER BY created_at DESC LIMIT 30', [run.id]);
  return {
    run: {
      id: run.id, key: run.daily_key || localDay(run.started_at) || '—',
      status: run.is_active ? runStatus(run.status) : 'superseded',
      mode: run.run_mode || 'start', scope: run.run_scope,
      runner: (my.asJson(run.summary_json) || {}).runner || null,
      trigger: run.trigger_source || '—', actor: run.triggered_by || run.trigger_source || 'system',
      started: dt(run.started_at), finished: dt(run.finished_at), durMs: durMs(run.started_at, run.finished_at),
      error: run.error_message || null,
    },
    steps,
    sources: srcRows.map((s) => ({
      name: s.source_name, group: s.source_group || '—', type: s.source_type || '—',
      url: s.source_url || s.query_text || '', status: s.status, http: s.http_status || 0,
      found: s.items_found || 0, inserted: s.items_inserted || 0, dur: s.duration_ms || 0,
      error: s.error_message || s.warning_message || '',
      samples: my.asJson(s.sample_titles_json) || [],
      chronicFail: (failCounts[s.source_name] || 0) >= 3,
    })),
    actions: actions.map((x) => ({ t: dt(x.created_at), actor: x.actor || '—', action: x.action, status: x.status, detail: x.error_message || '—' })),
    sourceClassification,
    failedModelRuns: failedModelRuns.map((m) => ({
      task: m.task_type, model: m.model_name || '—',
      error: (m.error_message || '').slice(0, 200) || '调用失败', t: dt(m.started_at),
    })),
    transitions: transitions.map((t) => ({
      t: dt(t.created_at), entity: t.entity_type, entityId: t.entity_id,
      from: t.from_status || '—', to: t.to_status, reason: t.reason || '', actor: t.actor || '系统',
    })),
  };
}

// ---------- 终审 ----------
const REVIEW_TARGETS = ['reviewed', 'approved_for_publish', 'archived', 'rejected', 'ready_for_review'];
function checkTransition(from, to, note) {
  if ((to === 'reviewed' || to === 'approved_for_publish') && !['ready_for_review', 'reviewed'].includes(from)) {
    return `只有 ready_for_review / reviewed 可进入 ${to}（当前: ${from}）`;
  }
  if (to === 'ready_for_review' && from !== 'reviewed') return `只能从 reviewed 回退（当前: ${from}）`;
  if (to === 'archived' && from === 'published') return 'published 不能归档';
  if (to === 'rejected' && !note) return '打回必须填写原因';
  return null;
}

async function reviewArticle({ id, status, note, actor }) {
  if (!REVIEW_TARGETS.includes(status)) return { code: 400, data: { ok: false, error: `status 非法: ${status}` } };
  const article = (await my.query('SELECT * FROM articles WHERE id = ?', [id]))[0];
  if (!article) return { code: 404, data: { ok: false, error: '未找到文章' } };
  let violation = checkTransition(article.status, status, note);
  if (!violation && ['reviewed', 'approved_for_publish'].includes(status)
      && article.article_quality_score != null && article.article_quality_score < 80) {
    violation = `文章质量主评分 ${article.article_quality_score} < 80，不得${status === 'reviewed' ? '通过复审' : '批准发布'}（SEO/GEO 不能覆盖质量不足）`;
  }
  if (violation) return { code: 409, data: { ok: false, error: violation } };
  const now = my.now();
  await my.update('articles', { status, updated_at: now }, 'id = ?', [article.id]);
  await my.insert('review_actions', {
    id: my.makeId('review'), article_id: article.id, before_status: article.status, after_status: status,
    action: 'mark', note: note || null, actor: actor || 'web', dry_run: 0, created_at: now,
  });
  const trace = require('./trace_lib');
  await trace.logStatusTransition({ entityType: 'article', entityId: article.id, fromStatus: article.status, toStatus: status, reason: note || '人工终审标记', actor: actor || 'web' });
  return { code: 200, data: { ok: true, articleId: article.id, beforeStatus: article.status, afterStatus: status } };
}

// ---------- 策略文档内容（只读查看）----------
async function configDoc(key) {
  const row = (await my.query('SELECT config_key, config_type, content, version, updated_by, updated_at FROM app_configs WHERE config_key = ?', [key]))[0];
  if (!row) return null;
  return {
    key: row.config_key, type: row.config_type, version: `v${row.version}`,
    by: row.updated_by || '—', updated: dt(row.updated_at),
    content: row.content || '',
  };
}

// ---------- 配置开关 ----------
async function toggleConfig(table, id, enabled) {
  if (!['config_keywords', 'config_sources'].includes(table)) return { code: 400, data: { ok: false, error: 'bad table' } };
  const row = (await my.query(`SELECT id FROM ${table} WHERE id = ?`, [id]))[0];
  if (!row) return { code: 404, data: { ok: false, error: '未找到配置项' } };
  await my.update(table, { enabled: enabled ? 1 : 0, updated_at: my.now() }, 'id = ?', [id]);
  return { code: 200, data: { ok: true, id, enabled: !!enabled } };
}

module.exports = { uiBootstrap, uiArticle, uiRun, reviewArticle, toggleConfig, configDoc, uiAuditions, uiAudition, uiDays, uiDay, uiDaySources, uiSourcesOverview, uiCanonicalSources, uiObservations, uiModelRuns, uiModelRun, saveConfigDoc };
