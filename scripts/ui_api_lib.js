// ui_api_lib.js — ContentFlow 监控台（webpage/）专用聚合查询层
// 把 MySQL 真实数据整形成前端页面需要的形状；只读为主，终审/配置开关为受控写入。
const my = require('./mysql_lib');
const rc = require('./run_control_lib');

// ---------- 通用映射 ----------
// workflow_steps.step_key → 前端 7 步流水线 key（db_list 是快照步骤，不展示）
const STEP_KEY_MAP = {
  collect_sources: 'collect',
  'run_topic-generation': 'topics',
  'jobs_create-articles': 'tasks',
  'jobs_run-articles': 'generate',
  'jobs_run-fact-check': 'factcheck',
  channels_generate: 'channels',
  'run_seo-geo-score': 'score',
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
    my.query('SELECT id, name, group_name, type, enabled FROM config_sources ORDER BY group_name, name'),
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
    sources: src.map((s) => ({ id: s.id, name: s.name, group: s.group_name || '—', type: s.type || '—', enabled: !!s.enabled, health: healthOf(s.name, s.enabled) })),
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
  };
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
  const failedModelRuns = await my.query("SELECT task_type, model_name, error_message, started_at FROM model_runs WHERE engine_run_id = ? AND status = 'failed' ORDER BY started_at DESC LIMIT 20", [run.id]);
  const transitions = await my.query('SELECT entity_type, entity_id, from_status, to_status, reason, actor, created_at FROM status_transitions WHERE engine_run_id = ? ORDER BY created_at DESC LIMIT 30', [run.id]);
  return {
    run: {
      id: run.id, key: run.daily_key || localDay(run.started_at) || '—',
      status: run.is_active ? runStatus(run.status) : 'superseded',
      mode: run.run_mode || 'start', scope: run.run_scope,
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
  const violation = checkTransition(article.status, status, note);
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

module.exports = { uiBootstrap, uiArticle, uiRun, reviewArticle, toggleConfig, configDoc };
