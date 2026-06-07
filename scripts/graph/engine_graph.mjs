#!/usr/bin/env node
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { StateGraph, START, END } from '@langchain/langgraph';
import { GraphAnnotation, initialGraphState } from './graph_state.mjs';
import { STEP_SPECS, makeGraphNodeContext, makeStepNode, refreshArticleCounts } from './nodes.mjs';

const require = createRequire(import.meta.url);
const my = require('../lib/mysql_lib');
const trace = require('../lib/trace_lib');
const runtime = require('../lib/workflow_runtime_lib');
const { loadPolicy } = require('../lib/production_policy_lib');

export function buildGraphDryRunPlan(args) {
  return [
    { name: 'sources:collect' },
    { name: 'topics:generate' },
    { name: 'quota:loop', targetReady: args.targetReady, maxAttempts: args.maxAttempts },
    { name: 'jobs:create', args: ['--limit', String(args.limit), '--min-score', String(args.minScore || 80), '--strategy', args.strategy || 'balanced'] },
    { name: 'jobs:run' },
    { name: 'factcheck:run' },
    ...(args.skipSeoGeoScore ? [] : [{ name: 'score:seo-geo' }]),
    { name: 'channels:generate' },
    { name: 'db:list' },
  ];
}

export function parseGraphArgs(argv = process.argv) {
  const normalized = ['node', argv[1] || 'scripts/graph/engine_graph.mjs'];
  let isActiveExplicit = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--actor') {
      normalized.push('--triggered-by', argv[++i]);
    } else {
      if (argv[i] === '--is-active') isActiveExplicit = true;
      normalized.push(argv[i]);
    }
  }
  const args = runtime.parseBatchArgs(normalized);
  if (!isActiveExplicit) args.isActive = args.runScope === 'daily' ? 1 : 0;
  return args;
}

export function buildGraph({ stepOrderRef = { value: 0 } } = {}) {
  const ctx = makeGraphNodeContext({ stepOrderRef });
  const graph = new StateGraph(GraphAnnotation);

  graph.addNode('collect_sources', makeStepNode(STEP_SPECS.collectSources, ctx));
  graph.addNode('generate_topics', makeStepNode(STEP_SPECS.generateTopics, ctx));
  graph.addNode('create_jobs', makeStepNode(STEP_SPECS.createJobs, ctx));
  graph.addNode('run_jobs', makeStepNode(STEP_SPECS.runJobs, ctx));
  graph.addNode('factcheck', makeStepNode(STEP_SPECS.factcheck, ctx));
  graph.addNode('refresh_counts', refreshArticleCounts);
  graph.addNode('score_seo_geo', makeStepNode(STEP_SPECS.scoreSeoGeo, ctx));
  graph.addNode('channels', makeStepNode(STEP_SPECS.channels, ctx));
  graph.addNode('db_list', makeStepNode(STEP_SPECS.dbList, ctx));

  graph.addEdge(START, 'collect_sources');
  graph.addEdge('collect_sources', 'generate_topics');
  graph.addEdge('generate_topics', 'create_jobs');
  graph.addConditionalEdges('create_jobs', (s) => (s.noMoreCandidates ? 'refresh_counts' : 'run_jobs'));
  graph.addEdge('run_jobs', 'factcheck');
  graph.addEdge('factcheck', 'refresh_counts');
  graph.addConditionalEdges('refresh_counts', (s) => {
    const shouldFinish = (s.readyCount || 0) >= s.targetReady || s.noMoreCandidates || (s.attempts || 0) >= s.maxAttempts;
    return shouldFinish ? 'score_seo_geo' : 'create_jobs';
  });
  graph.addEdge('score_seo_geo', 'channels');
  graph.addEdge('channels', 'db_list');
  graph.addEdge('db_list', END);
  return graph.compile();
}

async function ensureEngineRun(args, engineRunId) {
  const existingRun = (await my.query('SELECT id FROM engine_runs WHERE id = ?', [engineRunId]))[0];
  if (existingRun) {
    await my.update('engine_runs', { status: 'running', updated_at: my.now() }, 'id = ?', [engineRunId]);
    return 'existing';
  }

  await my.insert('engine_runs', {
    id: engineRunId,
    run_type: args.runType,
    status: 'running',
    started_at: my.now(),
    daily_key: args.dailyKey,
    run_scope: args.runScope,
    run_mode: args.runMode,
    is_active: args.isActive,
    triggered_by: args.triggeredBy,
    trigger_source: args.triggerSource,
  });
  return 'created';
}

function summarizeStatus(out) {
  const businessOutcome = runtime.businessOutcome({
    readyCount: out.readyCount || 0,
    targetReady: out.targetReady,
    technicalFailed: (out.errors || []).length > 0 && (out.readyCount || 0) === 0 && !out.noMoreCandidates,
  });
  const hasTechnicalErrors = (out.errors || []).length > 0;
  const hasBusinessProgress = (out.readyCount || 0) > 0 || (out.articlesGenerated || 0) > 0 || (out.topicsSelected || 0) > 0;
  const status = businessOutcome === 'target_met' && !hasTechnicalErrors
    ? 'succeeded'
    : hasTechnicalErrors && !hasBusinessProgress && !out.noMoreCandidates
      ? 'failed'
      : 'partial';
  return { businessOutcome, status };
}

async function runGraph(args) {
  if (args.engineNow) process.env.ENGINE_NOW = args.engineNow;
  await require('../lib/config_lib').ensureInit();

  const engineRunId = args.runId || my.makeRunId('graph');
  const targetReady = runtime.resolvedTargetReady(args);
  const stepOrderRef = { value: 0 };
  const state = initialGraphState({ ...args, engineRunId, targetReady });

  await ensureEngineRun(args, engineRunId);
  await trace.logWorkflowEvent({
    engineRunId,
    eventType: 'engine_started',
    level: 'info',
    message: `graph engine ${args.runType} 启动（target ${targetReady}, limit ${args.limit}, strategy ${args.strategy}）`,
    data: { runner: 'langgraph', limit: args.limit, targetReady, maxAttempts: args.maxAttempts, minScore: args.minScore, strategy: args.strategy, engineNow: args.engineNow },
  });

  const app = buildGraph({ stepOrderRef });
  const out = await app.invoke(state, { recursionLimit: Math.max(25, args.maxAttempts * 5 + 20) });
  const traceFailures = trace.getTraceFailures();
  const warnings = [...(out.warnings || [])];
  if (traceFailures.count > 0) warnings.push(`trace 写入失败 ${traceFailures.count} 次: ${traceFailures.samples.slice(0, 2).join('; ')}`);
  const nextActions = [];
  if ((out.factChecksCompleted || 0) > 0) nextActions.push('npm run db:list -- --status needs_fact_sources 查看待补来源');
  if ((out.qualityFailedCount || 0) > 0) nextActions.push('npm run score:article-quality -- --status needs_quality_revision --force 查看/重评质量不足文章');
  if ((out.errors || []).some((e) => /network connection error|LLM request failed/.test(e))) nextActions.push('LLM provider 不可达——检查代理后重跑');

  const { businessOutcome, status } = summarizeStatus({ ...out, warnings });
  const summary = {
    ok: status === 'succeeded',
    runner: 'langgraph',
    engineRunId,
    strategy: args.strategy,
    targetReady,
    maxAttempts: args.maxAttempts,
    businessOutcome,
    traceFailures: traceFailures.count,
    ...out,
    warnings: warnings.slice(0, 15),
    errors: (out.errors || []).slice(0, 15),
    nextActions,
  };

  await trace.logWorkflowEvent({
    engineRunId,
    eventType: 'engine_completed',
    level: summary.errors.length || status !== 'succeeded' ? 'warning' : 'info',
    message: `graph engine ${status}：ready ${summary.readyCount}/${targetReady} / 尝试 ${summary.attempts} / 错误 ${summary.errors.length}`,
    data: { runner: 'langgraph', businessOutcome },
  });

  await my.update('engine_runs', {
    status,
    finished_at: my.now(),
    topics_collected: summary.topicsCollected || 0,
    topics_selected: summary.topicsSelected || 0,
    articles_generated: summary.articlesGenerated || 0,
    articles_validated: summary.readyCount || 0,
    fact_checks_completed: summary.factChecksCompleted || 0,
    channel_outputs_generated: summary.channelOutputsGenerated || 0,
    summary_json: summary,
    error_message: summary.errors.length ? summary.errors.slice(0, 5).join(' | ').slice(0, 800) : null,
  }, 'id = ?', [engineRunId]);

  return { summary, status };
}

export async function main(argv = process.argv) {
  const args = parseGraphArgs(argv);
  if (args.engineNow) process.env.ENGINE_NOW = args.engineNow;

  const policy = loadPolicy();
  const maxLimit = policy.batch_limits.max_limit_without_force;
  if (args.limit > maxLimit && !args.force) {
    console.log(JSON.stringify({ ok: false, error: `--limit ${args.limit} 超过生产上限 ${maxLimit}，确需批量请加 --force。` }, null, 2));
    process.exitCode = 1;
    return;
  }

  if (args.dryRun) {
    const targetReady = runtime.resolvedTargetReady(args);
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      runner: 'langgraph',
      plan: buildGraphDryRunPlan({ ...args, targetReady }),
      state: initialGraphState({ ...args, targetReady }),
      message: 'dry-run：参数合法，未执行',
    }, null, 2));
    return;
  }

  try {
    const { summary, status } = await runGraph(args);
    process.stdout.write('\n=== [graph] 最终报告 ===\n');
    console.log(JSON.stringify(summary, null, 2));
    if (status === 'failed') process.exitCode = 1;
  } catch (err) {
    console.log(JSON.stringify({ ok: false, runner: 'langgraph', error: err.message }, null, 2));
    process.exitCode = 1;
  } finally {
    await my.closePool();
  }
}

const isCli = process.argv[1] === fileURLToPath(import.meta.url);
if (isCli) main();
