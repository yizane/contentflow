#!/usr/bin/env node
// engine_batch.js — 内容引擎主入口（DB-only：engine_runs 写 MySQL，子步骤经 ENGINE_RUN_ID 关联）
// 用法: npm run engine:batch -- --limit 1 --min-score 80 [--strategy geo_first] [--skip-seo-geo-score] [--force] [--dry-run]
const path = require('path');
const { execFileSync } = require('child_process');
const my = require('./lib/mysql_lib');
const { loadPolicy } = require('./lib/production_policy_lib');
const logger = require('./lib/logger_lib');
const runtime = require('./lib/workflow_runtime_lib');

const ROOT = my.ROOT;

function lastJson(stdout) {
  const idx = stdout.lastIndexOf('\n{');
  try { return JSON.parse(idx >= 0 ? stdout.slice(idx + 1) : stdout); } catch (_) {
    try { return JSON.parse(stdout); } catch (_) { return null; }
  }
}

let stepOrder = 0;

function nextDailyKey(dailyKey) {
  const d = new Date(`${dailyKey}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function countReadyForReview(engineRunId) {
  return (await my.query("SELECT COUNT(*) c FROM articles WHERE engine_run_id = ? AND status = 'ready_for_review'", [engineRunId]))[0].c;
}

async function countQualityFailed(engineRunId) {
  return (await my.query("SELECT COUNT(*) c FROM articles WHERE engine_run_id = ? AND status = 'needs_quality_revision'", [engineRunId]))[0].c;
}

async function countPendingJobs(engineRunId) {
  return (await my.query("SELECT COUNT(*) c FROM article_jobs WHERE engine_run_id = ? AND status = 'pending'", [engineRunId]))[0].c;
}

async function countRetryReusableJobs(args) {
  if (!args.retry || !args.dailyKey) return 0;
  const start = `${args.dailyKey} 00:00:00`;
  const end = `${nextDailyKey(args.dailyKey)} 00:00:00`;
  return (await my.query(
    "SELECT COUNT(*) c FROM article_jobs WHERE status IN ('pending', 'failed') AND created_at >= ? AND created_at < ?",
    [start, end]
  ))[0].c;
}

async function claimRetryReusableJobs(args, engineRunId) {
  if (!args.retry || !args.dailyKey) return 0;
  const start = `${args.dailyKey} 00:00:00`;
  const end = `${nextDailyKey(args.dailyKey)} 00:00:00`;
  const jobs = await my.query(
    `SELECT id FROM article_jobs WHERE status IN ('pending', 'failed') AND created_at >= ? AND created_at < ? ORDER BY created_at ASC LIMIT ${args.maxAttempts}`,
    [start, end]
  );
  const now = my.now();
  for (const j of jobs) {
    await my.update('article_jobs', { engine_run_id: engineRunId, updated_at: now }, 'id = ?', [j.id]);
  }
  return jobs.length;
}

// 带 workflow_steps trace 的步骤执行：创建 step → 子进程（带 WORKFLOW_STEP_ID）→ 完结 step
async function runStep(name, script, args = [], engineRunId, { skipped = false } = {}) {
  const trace = require('./lib/trace_lib');
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
  const args = runtime.parseBatchArgs(process.argv);
  if (args.engineNow) process.env.ENGINE_NOW = args.engineNow;
  if (args.dryRun) {
    const dryPolicy = loadPolicy();
    const maxLimit = dryPolicy.batch_limits.max_limit_without_force;
    if (args.limit > maxLimit && !args.force) {
      console.log(JSON.stringify({ ok: false, error: `--limit ${args.limit} 超过生产上限 ${maxLimit}，确需批量请加 --force。` }, null, 2));
      process.exit(1);
    }
    console.log(JSON.stringify({
      ok: true, dryRun: true,
      plan: runtime.buildBatchDryRunPlan(args),
      message: 'dry-run：参数合法，未执行',
    }, null, 2));
    return;
  }
  await require('./lib/config_lib').ensureInit();
  const policy = loadPolicy();
  const maxLimit = policy.batch_limits.max_limit_without_force;
  if (args.limit > maxLimit && !args.force) {
    console.log(JSON.stringify({ ok: false, error: `--limit ${args.limit} 超过生产上限 ${maxLimit}，确需批量请加 --force。` }, null, 2));
    process.exit(1);
  }

  const engineRunId = args.runId || my.makeRunId('engine');
  const warnings = [];
  const errors = [];
  const targetReady = runtime.resolvedTargetReady(args);
  const counts = {
    topicsCollected: 0,
    topicsSelected: 0,
    articlesGenerated: 0,
    articlesValidated: 0,
    factChecksCompleted: 0,
    channelOutputsGenerated: 0,
    attemptedJobs: 0,
    readyCount: 0,
    qualityFailedCount: 0,
  };
  let dedupeRejected = 0;
  let seoGeoScored = 0;
  let reusableJobs = 0;

  await my.insert('engine_runs', {
    id: engineRunId, run_type: args.runType, status: 'running', started_at: my.now(),
    daily_key: args.dailyKey, run_scope: args.runScope, run_mode: args.runMode,
    is_active: args.isActive, triggered_by: args.triggeredBy, trigger_source: args.triggerSource,
  });
  const trace = require('./lib/trace_lib');
  await trace.logWorkflowEvent({
    engineRunId,
    eventType: 'engine_started',
    level: 'info',
    message: `engine ${args.runType} 启动（target ${targetReady}, limit ${args.limit}, strategy ${args.strategy}）`,
    data: { limit: args.limit, targetReady, maxAttempts: args.maxAttempts, minScore: args.minScore, strategy: args.strategy, engineNow: args.engineNow },
  });

  if (args.retry) {
    reusableJobs = await countRetryReusableJobs(args);
    if (reusableJobs > 0) {
      const claimed = await claimRetryReusableJobs(args, engineRunId);
      warnings.push(`retry：接管当天 ${claimed} 个未完成 job，跳过 source/topic/job 新建`);
      counts.topicsSelected += claimed;
      await runStep('sources:collect', '', [], engineRunId, { skipped: true });
      await runStep('topics:generate', '', [], engineRunId, { skipped: true });
      await runStep('jobs:create', '', [], engineRunId, { skipped: true });
    }
  }

  if (!(args.retry && reusableJobs > 0)) {
    const collect = await runStep('sources:collect', 'pipeline/sources_collect.js', [], engineRunId);
    if (collect.ok && collect.result) {
      counts.topicsCollected = collect.result.summary ? collect.result.summary.total : 0;
      warnings.push(...(collect.result.warnings || []).slice(0, 8));
    } else errors.push(`sources:collect: ${collect.error}`);

    const topicGen = await runStep('topics:generate', 'pipeline/topics_generate.js', [], engineRunId);
    if (topicGen.ok && topicGen.result) dedupeRejected = topicGen.result.dedupeRejected || 0;
    else if (!topicGen.ok) errors.push(`topics:generate: ${topicGen.error}`);
  }

  let attempts = 0;
  let noMoreCandidates = false;
  while (attempts < args.maxAttempts) {
    counts.readyCount = await countReadyForReview(engineRunId);
    if (counts.readyCount >= targetReady) break;

    const pending = await countPendingJobs(engineRunId);
    if (pending === 0) {
      const createJobs = await runStep('jobs:create', 'pipeline/jobs_create.js', ['--limit', String(args.limit), '--min-score', String(args.minScore), '--strategy', args.strategy], engineRunId);
      if (createJobs.ok && createJobs.result && createJobs.result.jobCount > 0) {
        counts.topicsSelected += createJobs.result.jobCount;
      } else {
        noMoreCandidates = true;
        warnings.push(`候选不足：ready ${counts.readyCount}/${targetReady}，无法继续补位`);
        if (createJobs && !createJobs.ok) errors.push(`jobs:create: ${createJobs.error}`);
        break;
      }
    }

    const includeFailed = args.retry && reusableJobs > 0 && attempts === 0;
    const articleRunArgs = ['--limit', String(args.limit), ...(includeFailed ? ['--include-failed'] : [])];
    const articleRun = await runStep('jobs:run', 'pipeline/jobs_run.js', articleRunArgs, engineRunId);
    let generatedOk = 0;
    if (articleRun.result) {
      const attempted = (articleRun.result.succeeded || 0) + (articleRun.result.failed || 0);
      generatedOk = articleRun.result.succeeded || 0;
      attempts += attempted;
      counts.attemptedJobs += attempted;
      counts.articlesGenerated += attempted;
      counts.articlesValidated += generatedOk;
      (articleRun.result.results || []).filter((r) => !r.ok).forEach((r) => warnings.push(`job ${r.jobId}: ${(r.failures || []).join('; ').slice(0, 200)}`));
      if (attempted === 0) {
        warnings.push('jobs:run 未处理任何 job，停止补位');
        break;
      }
    } else {
      errors.push(`jobs:run: ${articleRun.error}`);
      break;
    }

    if (generatedOk > 0) {
      const fc = await runStep('factcheck:run', 'pipeline/factcheck_run.js', ['--limit', String(Math.max(args.limit, targetReady))], engineRunId);
      if (fc.result) {
        counts.factChecksCompleted += fc.result.succeeded || 0;
        (fc.result.results || []).filter((r) => !r.ok).forEach((r) => errors.push(`fact check ${r.articleId}: ${r.error}`));
      } else if (!fc.ok) errors.push(`factcheck:run: ${fc.error}`);
    } else {
      await runStep('factcheck:run', '', [], engineRunId, { skipped: true });
    }

    counts.qualityFailedCount = await countQualityFailed(engineRunId);
  }

  counts.readyCount = await countReadyForReview(engineRunId);
  counts.qualityFailedCount = await countQualityFailed(engineRunId);
  if (attempts >= args.maxAttempts && counts.readyCount < targetReady) {
    warnings.push(`已达到 max-attempts=${args.maxAttempts}，ready ${counts.readyCount}/${targetReady}`);
  }
  if (noMoreCandidates && counts.readyCount === 0) {
    warnings.push('没有可用候选进入终审');
  }

  if (!args.skipSeoGeoScore && counts.readyCount > 0) {
    const score = await runStep('score:seo-geo', 'pipeline/score_seo_geo.js', ['--status', 'ready_for_review', '--strategy', args.strategy], engineRunId);
    if (score.result) {
      seoGeoScored = score.result.scored || 0;
      if (!score.ok) errors.push(`score:seo-geo: ${score.error || '部分失败'}`);
    } else if (!score.ok) errors.push(`score:seo-geo: ${score.error}`);
  } else if (args.skipSeoGeoScore) warnings.push('已跳过双评分');
  else await runStep('score:seo-geo', '', [], engineRunId, { skipped: true });

  if (counts.readyCount > 0) {
    const ch = await runStep('channels:generate', 'pipeline/channels_generate.js', ['--status', 'ready_for_review', '--missing-only'], engineRunId);
    if (ch.result) {
      counts.channelOutputsGenerated = ch.result.channelOutputsGenerated || 0;
      if (!ch.ok) errors.push(`channels:generate: ${ch.error || '部分失败'}`);
    } else if (!ch.ok) errors.push(`channels:generate: ${ch.error}`);
  } else {
    await runStep('channels:generate', '', [], engineRunId, { skipped: true });
  }

  await runStep('db:list', 'tools/db_list.js', ['--limit', '10'], engineRunId);

  const nextActions = [];
  if (counts.factChecksCompleted > 0) nextActions.push('npm run db:list -- --status needs_fact_sources 查看待补来源');
  if (counts.qualityFailedCount > 0) nextActions.push('npm run score:article-quality -- --status needs_quality_revision --force 查看/重评质量不足文章');
  if (errors.some((e) => /network connection error|LLM request failed/.test(e))) nextActions.push('LLM provider 不可达——检查代理后重跑');

  const businessOutcome = runtime.businessOutcome({ readyCount: counts.readyCount, targetReady, technicalFailed: errors.length > 0 && counts.readyCount === 0 && !noMoreCandidates });
  const status = businessOutcome === 'target_met' && errors.length === 0 ? 'succeeded' : counts.readyCount > 0 ? 'partial' : 'failed';
  const traceFailures = trace.getTraceFailures();
  if (traceFailures.count > 0) warnings.push(`⚠️ trace 写入失败 ${traceFailures.count} 次: ${traceFailures.samples.slice(0, 2).join('; ')}`);
  await trace.logWorkflowEvent({ engineRunId, eventType: 'engine_completed', level: errors.length || status !== 'succeeded' ? 'warning' : 'info', message: `engine ${status}：ready ${counts.readyCount}/${targetReady} / 尝试 ${counts.attemptedJobs} / 错误 ${errors.length}` });
  const summary = {
    ok: status === 'succeeded',
    engineRunId,
    strategy: args.strategy,
    targetReady,
    maxAttempts: args.maxAttempts,
    businessOutcome,
    retryReusableJobs: reusableJobs,
    ...counts,
    dedupeRejected,
    seoGeoScored,
    traceFailures: traceFailures.count,
    warnings: warnings.slice(0, 15),
    errors: errors.slice(0, 15),
    nextActions,
  };
  await my.update('engine_runs', {
    status, finished_at: my.now(), topics_collected: counts.topicsCollected, topics_selected: counts.topicsSelected,
    articles_generated: counts.articlesGenerated, articles_validated: counts.readyCount,
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
