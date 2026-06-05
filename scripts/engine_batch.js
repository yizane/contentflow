#!/usr/bin/env node
// engine_batch.js — 内容引擎主入口（DB-only：engine_runs 写 MySQL，子步骤经 ENGINE_RUN_ID 关联）
// 用法: npm run engine:batch -- --limit 1 --min-score 80 [--strategy geo_first] [--skip-seo-geo-score] [--force] [--dry-run]
const path = require('path');
const { execFileSync } = require('child_process');
const my = require('./mysql_lib');
const { loadPolicy } = require('./production_policy_lib');
const logger = require('./logger_lib');

const ROOT = my.ROOT;

function parseArgs(argv) {
  const args = { limit: 1, minScore: 80, runType: 'batch', force: false, strategy: 'balanced', skipSeoGeoScore: false, dryRun: false,
    runId: null, dailyKey: null, runScope: 'batch', runMode: 'start', triggeredBy: 'cli', triggerSource: 'cli', isActive: 1, retry: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--limit') args.limit = parseInt(argv[++i], 10) || 1;
    else if (argv[i] === '--min-score') args.minScore = parseInt(argv[++i], 10) || 80;
    else if (argv[i] === '--run-type') args.runType = argv[++i];
    else if (argv[i] === '--force') args.force = true;
    else if (argv[i] === '--strategy') args.strategy = argv[++i];
    else if (argv[i] === '--skip-seo-geo-score') args.skipSeoGeoScore = true;
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--run-id') args.runId = argv[++i];
    else if (argv[i] === '--daily-key') args.dailyKey = argv[++i];
    else if (argv[i] === '--run-scope') args.runScope = argv[++i];
    else if (argv[i] === '--run-mode') args.runMode = argv[++i];
    else if (argv[i] === '--triggered-by') args.triggeredBy = argv[++i];
    else if (argv[i] === '--trigger-source') args.triggerSource = argv[++i];
    else if (argv[i] === '--is-active') args.isActive = parseInt(argv[++i], 10);
    else if (argv[i] === '--retry') args.retry = true;
  }
  return args;
}

function lastJson(stdout) {
  const idx = stdout.lastIndexOf('\n{');
  try { return JSON.parse(idx >= 0 ? stdout.slice(idx + 1) : stdout); } catch (_) {
    try { return JSON.parse(stdout); } catch (_) { return null; }
  }
}

let stepOrder = 0;

// 带 workflow_steps trace 的步骤执行：创建 step → 子进程（带 WORKFLOW_STEP_ID）→ 完结 step
async function runStep(name, script, args = [], engineRunId, { skipped = false } = {}) {
  const trace = require('./trace_lib');
  stepOrder++;
  const stepId = await trace.createWorkflowStep({ engineRunId, stepKey: name.replace(/[:]/g, '_'), stepName: name, stepOrder, inputSummary: { args } });
  if (skipped) {
    await trace.finishWorkflowStep(stepId, { status: 'skipped' });
    return { name, ok: true, skipped: true, result: null };
  }
  await trace.startWorkflowStep(stepId);
  await trace.logWorkflowEvent({ engineRunId, workflowStepId: stepId, eventType: 'step_started', level: 'info', message: `步骤开始: ${name}` });

  process.stdout.write(`\n=== [engine] ${name} ===\n`);
  logger.log(`[${engineRunId}] 步骤开始: ${name} ${args.join(' ')}`);
  let outcome;
  try {
    const out = execFileSync('node', [path.join(ROOT, 'scripts', script), ...args], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000,
      env: { ...process.env, ENGINE_RUN_ID: engineRunId, WORKFLOW_STEP_ID: stepId },
    });
    process.stdout.write(out.trim().slice(0, 1200) + '\n');
    logger.log(`[${engineRunId}] 步骤输出 ${name}:\n${out.trim().slice(0, 3000)}`);
    outcome = { name, ok: true, result: lastJson(out) };
  } catch (err) {
    const stdout = (err.stdout || '').toString();
    const stderr = (err.stderr || '').toString();
    process.stdout.write((stdout + stderr).trim().slice(0, 1200) + '\n');
    const parsed = lastJson(stdout);
    outcome = { name, ok: false, result: parsed, error: (parsed && parsed.error) || stderr.slice(0, 300) || 'unknown error' };
    logger.logError(`[${engineRunId}] 步骤失败 ${name}: ${outcome.error}\nstdout: ${stdout.slice(0, 2000)}\nstderr: ${stderr.slice(0, 1000)}`);
  }

  const hasWarnings = outcome.result && Array.isArray(outcome.result.warnings) && outcome.result.warnings.length > 0;
  await trace.finishWorkflowStep(stepId, {
    status: outcome.ok ? (hasWarnings ? 'warning' : 'success') : 'failed',
    outputSummary: outcome.result ? { ...outcome.result, results: undefined, items: undefined } : null,
    warnings: hasWarnings ? outcome.result.warnings.slice(0, 10) : null,
    errorMessage: outcome.ok ? null : outcome.error,
  });
  await trace.logWorkflowEvent({ engineRunId, workflowStepId: stepId, eventType: 'step_completed', level: outcome.ok ? 'info' : 'error', message: `步骤${outcome.ok ? '完成' : '失败'}: ${name}${outcome.ok ? '' : ` — ${outcome.error}`}` });
  return outcome;
}

async function main() {
  const args = parseArgs(process.argv);
  await require('./config_lib').ensureInit();
  const policy = loadPolicy();
  const maxLimit = policy.batch_limits.max_limit_without_force;
  if (args.limit > maxLimit && !args.force) {
    console.log(JSON.stringify({ ok: false, error: `--limit ${args.limit} 超过生产上限 ${maxLimit}，确需批量请加 --force。` }, null, 2));
    process.exit(1);
  }
  if (!['balanced', 'seo_first', 'geo_first'].includes(args.strategy)) {
    console.log(JSON.stringify({ ok: false, error: `strategy 非法: ${args.strategy}` }, null, 2));
    process.exit(1);
  }
  if (args.dryRun) {
    console.log(JSON.stringify({
      ok: true, dryRun: true,
      plan: { limit: args.limit, minScore: args.minScore, strategy: args.strategy, skipSeoGeoScore: args.skipSeoGeoScore, steps: ['collect:sources', 'run:topic-generation', `jobs:create-articles --limit ${args.limit} --strategy ${args.strategy}`, 'jobs:run-articles', 'jobs:run-fact-check', 'channels:generate', ...(args.skipSeoGeoScore ? [] : ['run:seo-geo-score --status ready_for_review']), 'db:list'] },
      message: 'dry-run：参数合法，未执行',
    }, null, 2));
    return;
  }

  const engineRunId = args.runId || my.makeRunId('engine');
  const warnings = [];
  const errors = [];
  const counts = { topicsCollected: 0, topicsSelected: 0, articlesGenerated: 0, articlesValidated: 0, factChecksCompleted: 0, channelOutputsGenerated: 0 };
  let dedupeRejected = 0;
  let seoGeoScored = 0;

  await my.insert('engine_runs', {
    id: engineRunId, run_type: args.runType, status: 'running', started_at: my.now(),
    daily_key: args.dailyKey, run_scope: args.runScope, run_mode: args.runMode,
    is_active: args.isActive, triggered_by: args.triggeredBy, trigger_source: args.triggerSource,
  });
  const trace = require('./trace_lib');
  await trace.logWorkflowEvent({ engineRunId, eventType: 'engine_started', level: 'info', message: `engine ${args.runType} 启动（limit ${args.limit}, strategy ${args.strategy}）`, data: { limit: args.limit, minScore: args.minScore, strategy: args.strategy } });

  const collect = await runStep('collect:sources', 'collect_sources.js', [], engineRunId);
  if (collect.ok && collect.result) {
    counts.topicsCollected = collect.result.summary ? collect.result.summary.total : 0;
    warnings.push(...(collect.result.warnings || []).slice(0, 8));
  } else errors.push(`collect:sources: ${collect.error}`);

  const topicGen = await runStep('run:topic-generation', 'run_topic_generation.js', [], engineRunId);
  if (topicGen.ok && topicGen.result) dedupeRejected = topicGen.result.dedupeRejected || 0;
  else if (!topicGen.ok) errors.push(`run:topic-generation: ${topicGen.error}`);

  // retry 模式：当天已有 pending/failed job 时直接复用，不再新建（避免重复创建成功文章）
  let reusableJobs = 0;
  if (args.retry) {
    reusableJobs = (await my.query("SELECT COUNT(*) c FROM article_jobs WHERE status IN ('pending', 'failed') AND created_at >= ?", [`${args.dailyKey || my.now().slice(0, 10)} 00:00:00`]))[0].c;
  }
  let createJobs;
  if (args.retry && reusableJobs > 0) {
    warnings.push(`retry：复用当天 ${reusableJobs} 个未完成 job，跳过新建`);
    createJobs = await runStep('jobs:create-articles', '', [], engineRunId, { skipped: true });
    counts.topicsSelected = reusableJobs;
  } else {
    createJobs = await runStep('jobs:create-articles', 'create_article_jobs.js', ['--limit', String(args.limit), '--min-score', String(args.minScore), '--strategy', args.strategy], engineRunId);
    if (createJobs.ok && createJobs.result) counts.topicsSelected = createJobs.result.jobCount || 0;
    else errors.push(`jobs:create-articles: ${createJobs.error}`);
  }

  if (counts.topicsSelected > 0) {
    const articleRun = await runStep('jobs:run-articles', 'run_article_jobs.js', [], engineRunId);
    if (articleRun.result) {
      counts.articlesGenerated = (articleRun.result.succeeded || 0) + (articleRun.result.failed || 0);
      counts.articlesValidated = articleRun.result.succeeded || 0;
      (articleRun.result.results || []).filter((r) => !r.ok).forEach((r) => errors.push(`job ${r.jobId}: ${(r.failures || []).join('; ').slice(0, 200)}`));
    } else if (!articleRun.ok) errors.push(`jobs:run-articles: ${articleRun.error}`);
  } else {
    warnings.push('没有选出主题，跳过文章生成');
    await runStep('jobs:run-articles', '', [], engineRunId, { skipped: true });
  }

  if (counts.articlesValidated > 0) {
    const fc = await runStep('jobs:run-fact-check', 'run_fact_check_jobs.js', [], engineRunId);
    if (fc.result) {
      counts.factChecksCompleted = fc.result.succeeded || 0;
      (fc.result.results || []).filter((r) => !r.ok).forEach((r) => errors.push(`fact check ${r.articleId}: ${r.error}`));
    } else if (!fc.ok) errors.push(`jobs:run-fact-check: ${fc.error}`);

    const ch = await runStep('channels:generate', 'run_channel_repurpose.js', [], engineRunId);
    if (ch.result) {
      counts.channelOutputsGenerated = ch.result.channelOutputsGenerated || 0;
      if (!ch.ok) errors.push(`channels:generate: ${ch.error || '部分失败'}`);
    } else if (!ch.ok) errors.push(`channels:generate: ${ch.error}`);
  } else {
    warnings.push('没有通过校验的文章，跳过核查与渠道');
    await runStep('jobs:run-fact-check', '', [], engineRunId, { skipped: true });
    await runStep('channels:generate', '', [], engineRunId, { skipped: true });
  }

  if (!args.skipSeoGeoScore) {
    const score = await runStep('run:seo-geo-score', 'run_seo_geo_score.js', ['--status', 'ready_for_review', '--strategy', args.strategy], engineRunId);
    if (score.result) {
      seoGeoScored = score.result.scored || 0;
      if (!score.ok) errors.push(`run:seo-geo-score: ${score.error || '部分失败'}`);
    } else if (!score.ok) errors.push(`run:seo-geo-score: ${score.error}`);
  } else warnings.push('已跳过双评分');

  await runStep('db:list', 'db_list_articles.js', ['--limit', '10'], engineRunId);

  const nextActions = [];
  if (counts.factChecksCompleted > 0) nextActions.push('npm run db:list -- --status needs_fact_sources 查看待补来源');
  if (errors.some((e) => /network connection error|LLM request failed/.test(e))) nextActions.push('LLM provider 不可达——检查代理后重跑');

  const status = errors.length === 0 ? 'succeeded' : counts.articlesValidated > 0 ? 'partial' : 'failed';
  const traceFailures = trace.getTraceFailures();
  if (traceFailures.count > 0) warnings.push(`⚠️ trace 写入失败 ${traceFailures.count} 次: ${traceFailures.samples.slice(0, 2).join('; ')}`);
  await trace.logWorkflowEvent({ engineRunId, eventType: 'engine_completed', level: errors.length ? 'warning' : 'info', message: `engine ${status}：生成 ${counts.articlesValidated} 篇 / 错误 ${errors.length}` });
  const summary = { ok: errors.length === 0, engineRunId, strategy: args.strategy, ...counts, dedupeRejected, seoGeoScored, traceFailures: traceFailures.count, warnings: warnings.slice(0, 15), errors: errors.slice(0, 15), nextActions };
  await my.update('engine_runs', {
    status, finished_at: my.now(), topics_collected: counts.topicsCollected, topics_selected: counts.topicsSelected,
    articles_generated: counts.articlesGenerated, articles_validated: counts.articlesValidated,
    fact_checks_completed: counts.factChecksCompleted, channel_outputs_generated: counts.channelOutputsGenerated,
    summary_json: summary, error_message: errors.length ? errors.slice(0, 5).join(' | ').slice(0, 800) : null,
  }, 'id = ?', [engineRunId]);
  await my.closePool();

  process.stdout.write('\n=== [engine] 最终报告 ===\n');
  console.log(JSON.stringify(summary, null, 2));
  logger.log(`[${engineRunId}] 最终报告: ${JSON.stringify(summary)}`);
  if (status === 'failed') process.exit(1);
}

main().catch(async (err) => {
  console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
  await my.closePool();
  process.exit(1);
});
