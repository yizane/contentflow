#!/usr/bin/env node
// jobs_create.js — Topic Portfolio Balancer 选题 → article_jobs（Phase 12B）
// 不再「raw_score 最高者胜」：selection_score = raw_score - 饱和惩罚 + 组合奖励，
// 高分但近期主题饱和 → deferred（窗口后自动回池）；每个决策可解释、写 MySQL trace。
// 用法:
//   npm run jobs:create -- --limit 3 --dry-run
//   npm run jobs:create -- --limit 3 --dry-run --show-portfolio-debug
//   npm run jobs:create -- --limit 1 [--min-score 80] [--category X] [--strategy balanced]
const my = require('../lib/mysql_lib');

const STRATEGIES = ['balanced', 'seo_first', 'geo_first'];

function parseArgs(argv) {
  const args = { limit: 1, minScore: 80, category: null, strategy: 'balanced', strategies: null, dryRun: false, showDebug: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--limit') args.limit = parseInt(argv[++i], 10) || 1;
    else if (argv[i] === '--min-score') args.minScore = parseInt(argv[++i], 10) || 80;
    else if (argv[i] === '--category') args.category = argv[++i];
    else if (argv[i] === '--strategy') args.strategy = argv[++i];
    else if (argv[i] === '--strategies') args.strategies = argv[++i].split(',').map((s) => s.trim());
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--show-portfolio-debug') args.showDebug = true;
  }
  return args;
}

// 决策行 → 输出摘要
function decisionRow(x, showDebug) {
  const c = x.candidate;
  const d = x.decision;
  const row = {
    topic: c.topic,
    rawScore: d.rawScore,
    contentValueScore: d.contentValueScore,
    selectionScore: d.selectionScore,
    contentType: c.content_type, businessCategory: c.business_category, topicCluster: c.topic_cluster,
    primaryKeyword: c.primary_keyword,
    selectionStatus: x.batchReason ? 'batch_skipped' : d.selectionStatus,
    skipReason: x.batchReason || d.skipReason || undefined,
    deferredUntil: d.deferredUntil ? d.deferredUntil.slice(0, 10) : undefined,
    penaltySummary: d.penalties.map((p) => `${p.type}:${p.value}`).join(' ') || undefined,
    bonusSummary: d.bonuses.map((b) => `${b.type}:+${b.value}`).join(' ') || undefined,
  };
  if (showDebug) row.portfolioDebug = { penalties: d.penalties, bonuses: d.bonuses, similarity: d.similarity };
  return row;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!STRATEGIES.includes(args.strategy)) {
    console.log(JSON.stringify({ ok: false, error: `strategy 非法: ${args.strategy}` }, null, 2));
    process.exit(1);
  }
  if (args.strategies) {
    console.log(JSON.stringify({ ok: false, error: '--strategies 多策略并行尚未实现（P2 TODO）', parsed: args.strategies }, null, 2));
    process.exit(1);
  }

  try {
    await require('../lib/config_lib').ensureInit();
    const portfolio = require('../lib/topic_portfolio_lib');
    const engineRunId = process.env.ENGINE_RUN_ID || null;

    const r = await portfolio.selectTopicCandidates({
      limit: args.limit, minScore: args.minScore, category: args.category,
      dryRun: args.dryRun, engineRunId,
    });

    const out = {
      ok: true,
      mode: 'portfolio_balanced',
      selected: r.selected.map((x) => decisionRow(x, args.showDebug)),
      deferred: r.deferred.map((x) => decisionRow(x, args.showDebug)),
      batchSkipped: r.batchSkipped.map((x) => decisionRow(x, args.showDebug)),
    };

    if (r.selected.length === 0) {
      out.ok = false;
      out.error = r.decisions.length === 0
        ? `没有符合条件的候选主题（score>=${args.minScore}）`
        : `高分候选全部被组合节流（deferred ${r.deferred.length} 个）`;
      out.hint = r.decisions.length === 0
        ? '先运行 npm run topics:generate 或降低 --min-score'
        : '近期同主题已饱和；等 deferred 窗口期过、补充其他业务分类的关键词（npm run keywords:analyze），或降低 --min-score';
      console.log(JSON.stringify(out, null, 2));
      process.exitCode = 1;
      return;
    }

    if (args.dryRun) {
      out.dryRun = true;
      out.message = 'dry-run：未写 article_jobs，未更新候选状态';
      console.log(JSON.stringify(out, null, 2));
      return;
    }

    // 选中候选 → article_jobs
    const now = my.now();
    const trace = require('../lib/trace_lib');
    const jobs = [];
    for (const x of r.selected) {
      const c = x.candidate;
      const jobId = my.makeId('job');
      await my.insert('article_jobs', {
        id: jobId, engine_run_id: engineRunId, topic_candidate_id: c.id, topic: c.topic,
        primary_keyword: c.primary_keyword, secondary_keywords_json: my.asJson(c.secondary_keywords_json) || [],
        category: c.category, content_angle: c.content_angle, business_angle: c.business_angle,
        source_urls_json: my.asJson(c.source_urls_json) || [], strategy: args.strategy,
        content_type: c.content_type || null, business_category: c.business_category || null, topic_cluster: c.topic_cluster || null,
        status: 'pending', created_at: now, updated_at: now,
      });
      await trace.logStatusTransition({ entityType: 'topic_candidate', entityId: c.id, engineRunId, fromStatus: c.status, toStatus: 'selected', reason: `portfolio 选中（selection ${x.decision.selectionScore}）` });
      await trace.logStatusTransition({ entityType: 'article_job', entityId: jobId, engineRunId, fromStatus: null, toStatus: 'pending' });
      await trace.logWorkflowEvent({ engineRunId, workflowStepId: process.env.WORKFLOW_STEP_ID || null, eventType: 'article_job_created', level: 'info', message: `job 创建: ${c.topic.slice(0, 50)}`, relatedType: 'article_job', relatedId: jobId, data: { strategy: args.strategy, raw_score: x.decision.rawScore, selection_score: x.decision.selectionScore } });
      jobs.push({ jobId, topic: c.topic, primaryKeyword: c.primary_keyword, rawScore: x.decision.rawScore, selectionScore: x.decision.selectionScore });
    }
    out.jobCount = jobs.length;
    out.strategy = args.strategy;
    out.jobs = jobs;
    console.log(JSON.stringify(out, null, 2));
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
    process.exitCode = 1;
  } finally {
    await my.closePool();
  }
}

main();
