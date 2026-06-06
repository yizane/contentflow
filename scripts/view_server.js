#!/usr/bin/env node
// view_server.js — ContentFlow 监控台服务（webpage/ 前端 + 只读 API + 受控运行/终审操作）
// 只读 MySQL 为主；不暴露 .env/密码/RDS 地址；默认不返回完整 prompt/raw_response（仅摘要）。
// 用法: npm run viewer   或   PORT=5178 node scripts/view_server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const my = require('./lib/mysql_lib');
const rc = require('./lib/run_control_lib');
const ui = require('./lib/ui_api_lib');
const logger = require('./lib/logger_lib');

const ROOT = my.ROOT;
const PORT = parseInt(process.env.PORT || '5177', 10);
const VIEWER_DIR = path.join(ROOT, 'webpage');

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function dt(v) {
  return v ? String(v) : null;
}

// ---------- API handlers ----------
async function listEngineRuns(q) {
  const limit = Math.min(50, parseInt(q.get('limit') || '10', 10));
  let sql = 'SELECT * FROM engine_runs';
  const params = [];
  if (q.get('status')) { sql += ' WHERE status = ?'; params.push(q.get('status')); }
  sql += ` ORDER BY started_at DESC LIMIT ${limit}`;
  const rows = await my.query(sql, params);
  return rows.map((r) => ({
    id: r.id, run_type: r.run_type, status: r.status,
    daily_key: r.daily_key, run_scope: r.run_scope, run_mode: r.run_mode,
    is_active: !!r.is_active, superseded_by: r.superseded_by, trigger_source: r.trigger_source,
    topics_collected: r.topics_collected, topics_selected: r.topics_selected,
    articles_generated: r.articles_generated, articles_validated: r.articles_validated,
    fact_checks_completed: r.fact_checks_completed, channel_outputs_generated: r.channel_outputs_generated,
    started_at: dt(r.started_at), finished_at: dt(r.finished_at),
    duration_ms: r.finished_at ? new Date(r.finished_at) - new Date(r.started_at) : null,
    error_message: r.error_message,
  }));
}

async function engineRunDetail(id) {
  const run = (await my.query('SELECT * FROM engine_runs WHERE id = ?', [id]))[0];
  if (!run) return null;
  const steps = await my.query('SELECT id, step_key, step_name, step_order, status, started_at, finished_at, duration_ms, output_summary_json, warning_json, error_message FROM workflow_steps WHERE engine_run_id = ? ORDER BY step_order', [id]);
  const srcSummary = await my.query('SELECT status, COUNT(*) c, SUM(items_found) found, SUM(items_inserted) inserted FROM source_collection_logs WHERE engine_run_id = ? GROUP BY status', [id]);
  const events = await my.query('SELECT event_type, level, message, related_type, related_id, created_at FROM workflow_events WHERE engine_run_id = ? ORDER BY created_at DESC LIMIT 30', [id]);
  const articles = await my.query('SELECT id, title, status, quality_score, seo_score, geo_score FROM articles WHERE engine_run_id = ?', [id]);
  const failedModelRuns = await my.query("SELECT task_type, error_message, started_at FROM model_runs WHERE engine_run_id = ? AND status = 'failed' ORDER BY started_at DESC LIMIT 10", [id]);
  const runActions = await my.query('SELECT action, actor, trigger_source, status, error_message, created_at FROM run_actions WHERE engine_run_id = ? ORDER BY created_at DESC LIMIT 10', [id]);
  const transitions = await my.query('SELECT entity_type, entity_id, from_status, to_status, reason, created_at FROM status_transitions WHERE engine_run_id = ? ORDER BY created_at DESC LIMIT 20', [id]);
  return {
    run_actions: runActions.map((a) => ({ ...a, created_at: dt(a.created_at), error_message: (a.error_message || '').slice(0, 150) || null })),
    status_transitions: transitions.map((t) => ({ ...t, created_at: dt(t.created_at) })),
    engine_run: { ...run, started_at: dt(run.started_at), finished_at: dt(run.finished_at), summary_json: my.asJson(run.summary_json) },
    workflow_steps: steps.map((s) => ({ ...s, started_at: dt(s.started_at), finished_at: dt(s.finished_at), output_summary: my.asJson(s.output_summary_json), warnings: my.asJson(s.warning_json), output_summary_json: undefined, warning_json: undefined })),
    source_collection_summary: srcSummary,
    workflow_events_latest: events.map((e) => ({ ...e, created_at: dt(e.created_at) })),
    related_articles: articles,
    failed_model_runs: failedModelRuns.map((m) => ({ task_type: m.task_type, error: (m.error_message || '').slice(0, 200), started_at: dt(m.started_at) })),
  };
}

async function engineRunSources(id, q) {
  let sql = 'SELECT source_name, source_group, source_type, source_url, query_text, status, http_status, items_found, items_inserted, duration_ms, error_message, warning_message, sample_titles_json FROM source_collection_logs WHERE engine_run_id = ?';
  const params = [id];
  if (q.get('status')) { sql += ' AND status = ?'; params.push(q.get('status')); }
  if (q.get('source_group')) { sql += ' AND source_group = ?'; params.push(q.get('source_group')); }
  sql += ' ORDER BY status DESC, source_group, source_name LIMIT 200';
  const rows = await my.query(sql, params);
  return rows.map((r) => ({ ...r, sample_titles: my.asJson(r.sample_titles_json), sample_titles_json: undefined }));
}

async function engineRunEvents(id, q) {
  const limit = Math.min(500, parseInt(q.get('limit') || '100', 10));
  let sql = 'SELECT id, workflow_step_id, event_type, level, message, related_type, related_id, data_json, created_at FROM workflow_events WHERE engine_run_id = ?';
  const params = [id];
  if (q.get('level')) { sql += ' AND level = ?'; params.push(q.get('level')); }
  if (q.get('step')) { sql += ' AND workflow_step_id = ?'; params.push(q.get('step')); }
  sql += ` ORDER BY created_at ASC LIMIT ${limit}`;
  const rows = await my.query(sql, params);
  return rows.map((r) => ({ ...r, data: my.asJson(r.data_json), data_json: undefined, created_at: dt(r.created_at) }));
}

async function listArticles(q) {
  const limit = Math.min(100, parseInt(q.get('limit') || '30', 10));
  let sql = 'SELECT id, title, slug, status, quality_score, seo_score, geo_score, fact_publish_readiness, primary_keyword, content_type, business_category, topic_cluster, created_at, updated_at FROM articles';
  const where = [];
  const params = [];
  if (q.get('status')) { where.push('status = ?'); params.push(q.get('status')); }
  if (q.get('content_type')) { where.push('content_type = ?'); params.push(q.get('content_type')); }
  if (q.get('business_category')) { where.push('business_category = ?'); params.push(q.get('business_category')); }
  if (q.get('topic_cluster')) { where.push('topic_cluster = ?'); params.push(q.get('topic_cluster')); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ` ORDER BY created_at DESC LIMIT ${limit}`;
  return (await my.query(sql, params)).map((r) => ({ ...r, created_at: dt(r.created_at), updated_at: dt(r.updated_at) }));
}

async function articleDetail(id) {
  const a = (await my.query('SELECT * FROM articles WHERE id = ?', [id]))[0];
  if (!a) return null;
  const ver = await my.latestVersion(id);
  const channels = await my.query('SELECT channel, title, status, CHAR_LENGTH(content_markdown) len FROM channel_outputs WHERE article_id = ?', [id]);
  return {
    article: { ...a, created_at: dt(a.created_at), updated_at: dt(a.updated_at), secondary_keywords_json: my.asJson(a.secondary_keywords_json) },
    latest_version: ver ? {
      id: ver.id, version_label: ver.version_label, generation_mode: ver.generation_mode, strategy: ver.strategy,
      status: ver.status, markdown_length: (ver.article_markdown || '').length,
      markdown: ver.article_markdown, // Viewer 本地只读，正文可展示
      quality: my.asJson(ver.quality_json), fact_check: my.asJson(ver.fact_check_json),
      dual_quality: my.asJson(ver.dual_quality_json),
    } : null,
    channels,
  };
}

async function articleTrace(id) {
  const transitions = await my.query('SELECT entity_type, from_status, to_status, reason, actor, created_at FROM status_transitions WHERE entity_id = ? OR (entity_type = ? AND entity_id = ?) ORDER BY created_at', [id, 'article', id]);
  // 默认只给 model_runs 摘要（不含 prompt/raw_response 全文）
  const modelRuns = await my.query('SELECT id, task_type, model_name, status, started_at, finished_at, CHAR_LENGTH(task_prompt) prompt_chars, CHAR_LENGTH(raw_response) response_chars, error_message FROM model_runs WHERE article_id = ? ORDER BY started_at', [id]);
  const events = await my.query("SELECT event_type, level, message, created_at FROM workflow_events WHERE related_id = ? ORDER BY created_at LIMIT 100", [id]);
  const factChecks = await my.query('SELECT overall_risk, publish_readiness, claims_count, high_risk_count, must_fix_count, created_at FROM fact_checks WHERE article_id = ? ORDER BY created_at', [id]);
  const resolutions = await my.query('SELECT resolved_status, COUNT(*) c FROM source_resolutions WHERE article_id = ? GROUP BY resolved_status', [id]);
  const versions = await my.query('SELECT id, version_label, generation_mode, status, created_at FROM article_versions WHERE article_id = ? ORDER BY created_at', [id]);
  return {
    status_transitions: transitions.map((t) => ({ ...t, created_at: dt(t.created_at) })),
    model_runs_summary: modelRuns.map((m) => ({ ...m, started_at: dt(m.started_at), finished_at: dt(m.finished_at), error_message: (m.error_message || '').slice(0, 200) || null })),
    workflow_events: events.map((e) => ({ ...e, created_at: dt(e.created_at) })),
    fact_checks_history: factChecks.map((f) => ({ ...f, created_at: dt(f.created_at) })),
    source_resolutions_summary: resolutions,
    versions: versions.map((v) => ({ ...v, created_at: dt(v.created_at) })),
  };
}

// ---------- Run Control ----------
async function runControlToday() {
  const dailyKey = rc.getDailyKey();
  const { activeRun } = await rc.getTodayRunStatus({ dailyKey });
  const decision = await rc.canStartDaily({ dailyKey, mode: 'start' });
  let readyForReview = 0;
  if (activeRun) {
    readyForReview = (await my.query("SELECT COUNT(*) c FROM articles WHERE engine_run_id = ? AND status = 'ready_for_review'", [activeRun.id]))[0].c;
  }
  return {
    ok: true, dailyKey, hasRun: !!activeRun,
    run: activeRun ? {
      id: activeRun.id, status: activeRun.status, runScope: activeRun.run_scope, runMode: activeRun.run_mode,
      isActive: !!activeRun.is_active, topicsCollected: activeRun.topics_collected,
      articlesGenerated: activeRun.articles_generated, readyForReview,
      startedAt: dt(activeRun.started_at), finishedAt: dt(activeRun.finished_at),
    } : null,
    availableActions: decision.availableActions,
    message: decision.reason,
  };
}

async function runControlStart(body) {
  const mode = body.mode || 'start';
  const dailyKey = body.dailyKey || rc.getDailyKey();
  const actor = body.actor || 'local-viewer';
  if (!['start', 'retry', 'rebuild', 'force'].includes(mode)) {
    return { code: 400, data: { ok: false, error: `mode 非法: ${mode}` } };
  }
  const decision = await rc.canStartDaily({ dailyKey, mode });
  if (!decision.allowed) {
    await rc.recordRunAction({ dailyKey, action: `${mode}_daily`, actor, triggerSource: 'viewer', request: body, status: 'rejected', errorMessage: decision.reason, engineRunId: decision.activeRun ? decision.activeRun.id : null });
    return { code: 409, data: { ok: false, rejected: true, reason: decision.reason, availableActions: decision.availableActions } };
  }
  // 后台 spawn engine_daily（控制逻辑与归档由 engine_daily 自己执行），立即返回 accepted
  const child = spawn('node', [path.join(ROOT, 'scripts', 'engine_daily.js'), '--mode', mode, '--daily-key', dailyKey, '--actor', actor, '--trigger-source', 'viewer'], {
    detached: true, stdio: 'ignore', cwd: ROOT, env: process.env,
  });
  child.unref();
  return { code: 202, data: { ok: true, accepted: true, mode, dailyKey, message: `${mode} 已受理，后台执行中。轮询 /api/run-control/today 或 /api/engine-runs 查看进度。` } };
}

async function listRunActions(q) {
  const limit = Math.min(50, parseInt(q.get('limit') || '15', 10));
  const rows = await my.query(`SELECT id, engine_run_id, daily_key, action, actor, trigger_source, status, error_message, created_at FROM run_actions ORDER BY created_at DESC LIMIT ${limit}`);
  return rows.map((r) => ({ ...r, created_at: dt(r.created_at), error_message: (r.error_message || '').slice(0, 200) || null }));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 524288) req.destroy(); }); // 512KB：提示词编辑需要
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch (_) { resolve({}); }
    });
  });
}

// ---------- 单步重跑（Web 控制台）----------
// 白名单：step key → pipeline CLI。绝不透传任意命令/参数。
const STEP_CMDS = {
  collect:   { file: 'pipeline/sources_collect.js',       label: '采集来源' },
  classify:  { file: 'pipeline/content_classify.js',      label: '内容分类' },
  topics:    { file: 'pipeline/topics_generate.js',       label: '生成主题池' },
  jobs:      { file: 'pipeline/jobs_create.js',           label: '组合选题' },
  generate:  { file: 'pipeline/jobs_run.js',              label: '生成文章' },
  factcheck: { file: 'pipeline/factcheck_run.js',         label: '事实核查' },
  sourcesfix:{ file: 'pipeline/sources_fix.js',           label: '自动补源' },
  channels:  { file: 'pipeline/channels_generate.js',     label: '渠道改写' },
  score:     { file: 'pipeline/score_seo_geo.js',         label: 'SEO/GEO 评分' },
  quality:   { file: 'pipeline/articles_quality_score.js',label: '质量主评分' },
  report:    { file: 'engine_report.js',                  label: '生产报告' },
};
const stepJobs = {}; // step → { running, startedAt, finishedAt, exitCode, log: [...last 200 lines] }

function startStep(step) {
  const cmd = STEP_CMDS[step];
  if (!cmd) return { code: 400, data: { ok: false, error: `未知步骤: ${step}` } };
  if (stepJobs[step] && stepJobs[step].running) {
    return { code: 409, data: { ok: false, error: `${cmd.label} 已在运行中` } };
  }
  const job = { step, label: cmd.label, running: true, startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, log: [] };
  stepJobs[step] = job;
  const child = spawn('node', [path.join(ROOT, 'scripts', cmd.file)], { cwd: ROOT, env: process.env });
  const push = (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (!line.trim()) continue;
      job.log.push(line.slice(0, 400));
      if (job.log.length > 500) job.log.shift();
    }
  };
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  child.on('exit', (code) => { job.running = false; job.exitCode = code; job.finishedAt = new Date().toISOString(); });
  child.on('error', (e) => { job.running = false; job.exitCode = -1; job.finishedAt = new Date().toISOString(); job.log.push(`spawn 失败: ${e.message}`); });
  logger.log(`[控制台] 单步重跑 ${step}（${cmd.label}）`, { name: 'viewer' });
  return { code: 202, data: { ok: true, accepted: true, step, label: cmd.label } };
}

function stepStatus() {
  return Object.fromEntries(Object.entries(stepJobs).map(([k, j]) => [k, {
    label: j.label, running: j.running, startedAt: j.startedAt, finishedAt: j.finishedAt,
    exitCode: j.exitCode, lastLines: j.log.slice(-8),
  }]));
}

async function latestReport() {
  const r = (await my.query('SELECT id, report_json, report_markdown, created_at FROM engine_reports ORDER BY created_at DESC LIMIT 1'))[0];
  return r ? { id: r.id, created_at: dt(r.created_at), report: my.asJson(r.report_json), markdown: r.report_markdown } : null;
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const p = url.pathname;
    const q = url.searchParams;

    if (p === '/api/health') {
      try {
        const r = await my.query('SELECT 1 AS ok');
        return json(res, 200, { ok: true, db: r[0].ok === 1 ? 'connected' : 'unknown', viewer: 'read-only + run-control', version: 'v1.0-rc1' });
      } catch (err) {
        return json(res, 503, { ok: false, db: 'unreachable', error: 'MySQL 连接失败（详情见服务端日志，不在 API 暴露连接信息）' });
      }
    }
    if (p === '/api/dashboard') {
      const [counts, ready, runs, actions] = await Promise.all([
        my.query('SELECT status, COUNT(*) c FROM articles GROUP BY status'),
        my.query("SELECT COUNT(*) c FROM publish_packages WHERE ready_for_publish_package = 1"),
        my.query('SELECT COUNT(*) c FROM engine_runs'),
        my.query('SELECT COUNT(*) c FROM run_actions'),
      ]);
      return json(res, 200, {
        ok: true,
        articleStatusCounts: Object.fromEntries(counts.map((r) => [r.status, r.c])),
        readyPackages: ready[0].c, engineRuns: runs[0].c, runActions: actions[0].c,
        dailyKey: rc.getDailyKey(),
      });
    }
    let m;
    // ---- ContentFlow 监控台聚合 API（webpage/ 前端专用）----
    if (p === '/api/ui/bootstrap') return json(res, 200, await ui.uiBootstrap());
    if ((m = p.match(/^\/api\/ui\/article\/([\w-]+)$/))) {
      const d = await ui.uiArticle(m[1]);
      return d ? json(res, 200, { ok: true, article: d }) : json(res, 404, { ok: false, error: 'article not found' });
    }
    if ((m = p.match(/^\/api\/ui\/run\/([\w.-]+)$/))) {
      const d = await ui.uiRun(decodeURIComponent(m[1]));
      return d ? json(res, 200, { ok: true, ...d }) : json(res, 404, { ok: false, error: 'run not found' });
    }
    if ((m = p.match(/^\/api\/articles\/([\w-]+)\/review$/)) && req.method === 'POST') {
      const body = await readBody(req);
      const r = await ui.reviewArticle({ id: m[1], status: body.status, note: body.note, actor: body.actor || 'web' });
      return json(res, r.code, r.data);
    }
    if (p === '/api/ui/days') {
      return json(res, 200, { ok: true, days: await ui.uiDays(parseInt(q.get('limit') || '14', 10)) });
    }
    if ((m = p.match(/^\/api\/ui\/day\/(\d{4}-\d{2}-\d{2})$/))) {
      const d = await ui.uiDay(m[1]);
      return d ? json(res, 200, { ok: true, day: d }) : json(res, 404, { ok: false, error: 'bad date' });
    }
    if ((m = p.match(/^\/api\/ui\/day\/(\d{4}-\d{2}-\d{2})\/sources$/))) {
      const d = await ui.uiDaySources(m[1]);
      return d ? json(res, 200, { ok: true, detail: d }) : json(res, 404, { ok: false, error: 'bad date' });
    }
    if (p === '/api/ui/sources') {
      const [overview, canon] = await Promise.all([
        ui.uiSourcesOverview(),
        ui.uiCanonicalSources({ lane: q.get('lane') || '', status: q.get('status') || '', source: q.get('source') || '', limit: parseInt(q.get('limit') || '120', 10) }),
      ]);
      return json(res, 200, { ok: true, overview, items: canon.items, sourceFacet: canon.sourceFacet });
    }
    if (p === '/api/ui/observations') {
      const d = await ui.uiObservations({ date: q.get('date') || '', runId: q.get('run') || '', status: q.get('status') || '', limit: parseInt(q.get('limit') || '200', 10) });
      return json(res, 200, { ok: true, ...d });
    }
    // ---------- Web 控制台 ----------
    if (p === '/api/step/run' && req.method === 'POST') {
      const body = await readBody(req);
      const r = startStep(String(body.step || ''));
      return json(res, r.code, r.data);
    }
    if (p === '/api/step/status') return json(res, 200, { ok: true, steps: stepStatus() });
    if ((m = p.match(/^\/api\/step\/log\/([a-z]+)$/))) {
      const j = stepJobs[m[1]];
      return j ? json(res, 200, { ok: true, step: m[1], label: j.label, running: j.running, exitCode: j.exitCode, log: j.log })
               : json(res, 404, { ok: false, error: '该步骤还没有运行记录' });
    }
    if (p === '/api/ui/model-runs') {
      const d = await ui.uiModelRuns({ taskType: q.get('task') || '', runId: q.get('run') || '', articleId: q.get('article') || '', limit: parseInt(q.get('limit') || '50', 10) });
      return json(res, 200, { ok: true, ...d });
    }
    if ((m = p.match(/^\/api\/ui\/model-runs\/([\w-]+)$/))) {
      const d = await ui.uiModelRun(m[1]);
      return d ? json(res, 200, { ok: true, modelRun: d }) : json(res, 404, { ok: false, error: 'model run 不存在' });
    }
    if (p === '/api/config/doc/save' && req.method === 'POST') {
      const body = await readBody(req);
      const r = await ui.saveConfigDoc(String(body.key || ''), body.content, body.actor || 'web');
      return json(res, r.code, r.data);
    }
    if (p === '/api/topic-auditions' && req.method === 'GET') {
      return json(res, 200, { ok: true, auditions: await ui.uiAuditions(parseInt(q.get('limit') || '10', 10)) });
    }
    if ((m = p.match(/^\/api\/topic-auditions\/([\w-]+)$/)) && req.method === 'GET') {
      const d = await ui.uiAudition(m[1]);
      return d ? json(res, 200, { ok: true, audition: d }) : json(res, 404, { ok: false, error: 'audition not found' });
    }
    if (p === '/api/topic-auditions/run' && req.method === 'POST') {
      // 只跑 audition，不生成文章；后台 spawn，立即返回
      const body = await readBody(req);
      const rounds = Math.max(1, Math.min(60, parseInt(body.rounds || 10, 10)));
      const lim = Math.max(1, Math.min(5, parseInt(body.limit || 1, 10)));
      const child = spawn('node', [path.join(ROOT, 'scripts', 'pipeline', 'topic_audition.js'), '--rounds', String(rounds), '--limit', String(lim), '--json'], {
        detached: true, stdio: 'ignore', cwd: ROOT, env: process.env,
      });
      child.unref();
      return json(res, 202, { ok: true, accepted: true, rounds, limit: lim, message: 'audition 已受理（仅模拟选题，不生成文章）；轮询 GET /api/topic-auditions 查看结果' });
    }
    if (p === '/api/ui/config/doc') {
      const d = await ui.configDoc(q.get('key') || '');
      return d ? json(res, 200, { ok: true, doc: d }) : json(res, 404, { ok: false, error: 'config doc not found' });
    }
    if ((m = p.match(/^\/api\/config\/(keywords|sources)\/([\w-]+)\/toggle$/)) && req.method === 'POST') {
      const body = await readBody(req);
      const r = await ui.toggleConfig(m[1] === 'keywords' ? 'config_keywords' : 'config_sources', m[2], !!body.enabled);
      return json(res, r.code, r.data);
    }

    if (p === '/api/run-control/today') return json(res, 200, await runControlToday());
    if (p === '/api/run-control/start' && req.method === 'POST') {
      const body = await readBody(req);
      const r = await runControlStart(body);
      return json(res, r.code, r.data);
    }
    if (p === '/api/run-actions') return json(res, 200, { ok: true, actions: await listRunActions(q) });
    if (p === '/api/configs') {
      // 只读配置清单（未来 Web 管理页编辑 app_configs / config_keywords / config_sources）
      const docs = await my.query('SELECT config_key, config_type, version, updated_by, CHAR_LENGTH(content) content_chars, updated_at FROM app_configs ORDER BY config_type, config_key');
      const kw = (await my.query('SELECT COUNT(*) c FROM config_keywords WHERE enabled = 1'))[0].c;
      const src = (await my.query('SELECT COUNT(*) c FROM config_sources WHERE enabled = 1'))[0].c;
      return json(res, 200, { ok: true, keywordsEnabled: kw, sourcesEnabled: src, docs: docs.map((d) => ({ ...d, updated_at: dt(d.updated_at) })) });
    }
    if (p === '/api/engine-runs') return json(res, 200, { ok: true, runs: await listEngineRuns(q) });
    if ((m = p.match(/^\/api\/engine-runs\/([\w-]+)\/sources$/))) return json(res, 200, { ok: true, sources: await engineRunSources(m[1], q) });
    if ((m = p.match(/^\/api\/engine-runs\/([\w-]+)\/events$/))) return json(res, 200, { ok: true, events: await engineRunEvents(m[1], q) });
    if ((m = p.match(/^\/api\/engine-runs\/([\w-]+)$/))) {
      const d = await engineRunDetail(m[1]);
      return d ? json(res, 200, { ok: true, ...d }) : json(res, 404, { ok: false, error: 'run not found' });
    }
    if (p === '/api/articles') return json(res, 200, { ok: true, articles: await listArticles(q) });
    if ((m = p.match(/^\/api\/articles\/([\w-]+)\/trace$/))) return json(res, 200, { ok: true, ...(await articleTrace(m[1])) });
    if ((m = p.match(/^\/api\/articles\/([\w-]+)\/channels$/))) {
      const rows = await my.query('SELECT channel, title, content_markdown, status FROM channel_outputs WHERE article_id = ? ORDER BY channel', [m[1]]);
      return json(res, 200, { ok: true, channels: rows });
    }
    if ((m = p.match(/^\/api\/articles\/([\w-]+)$/))) {
      const d = await articleDetail(m[1]);
      return d ? json(res, 200, { ok: true, ...d }) : json(res, 404, { ok: false, error: 'article not found' });
    }
    if (p === '/api/report/latest') return json(res, 200, { ok: true, report: await latestReport() });

    // 静态文件
    const file = p === '/' ? 'index.html' : p.replace(/^\//, '');
    const abs = path.join(VIEWER_DIR, file);
    if (abs.startsWith(VIEWER_DIR) && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      const ext = path.extname(abs);
      const mime = { '.html': 'text/html', '.js': 'application/javascript', '.jsx': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' }[ext] || 'text/plain';
      const binary = ['.ico', '.png'].includes(ext);
      // 调试台代码改动频繁：html/js/jsx 不缓存，避免浏览器拿旧版页面
      const cache = binary ? 'max-age=86400' : 'no-cache';
      res.writeHead(200, { 'Content-Type': binary ? mime : `${mime}; charset=utf-8`, 'Cache-Control': cache });
      return res.end(fs.readFileSync(abs));
    }
    json(res, 404, { ok: false, error: 'not found' });
  } catch (err) {
    logger.logError(`Viewer API 错误 ${req.url}: ${err.message}`, { name: 'viewer' });
    json(res, 500, { ok: false, error: err.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Viewer (read-only) → http://127.0.0.1:${PORT}`);
});
