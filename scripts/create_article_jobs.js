#!/usr/bin/env node
// create_article_jobs.js — 从 topic_candidates 选高分主题写入 article_jobs 表（DB-only）
// 用法: npm run jobs:create-articles -- --limit 1 --min-score 80 [--category X] [--strategy balanced] [--dry-run]
const my = require('./mysql_lib');

const STRATEGIES = ['balanced', 'seo_first', 'geo_first'];

function parseArgs(argv) {
  const args = { limit: 1, minScore: 80, category: null, strategy: 'balanced', strategies: null, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--limit') args.limit = parseInt(argv[++i], 10) || 1;
    else if (argv[i] === '--min-score') args.minScore = parseInt(argv[++i], 10) || 80;
    else if (argv[i] === '--category') args.category = argv[++i];
    else if (argv[i] === '--strategy') args.strategy = argv[++i];
    else if (argv[i] === '--strategies') args.strategies = argv[++i].split(',').map((s) => s.trim());
    else if (argv[i] === '--dry-run') args.dryRun = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!STRATEGIES.includes(args.strategy)) {
    console.log(JSON.stringify({ ok: false, error: `strategy 非法: ${args.strategy}` }, null, 2));
    process.exit(1);
  }
  if (args.strategies) {
    // TODO(P2): 同题多策略并行生成
    console.log(JSON.stringify({ ok: false, error: '--strategies 多策略并行尚未实现（P2 TODO）', parsed: args.strategies }, null, 2));
    process.exit(1);
  }

  try {
    let sql = "SELECT * FROM topic_candidates WHERE status IN ('candidate', 'selected') AND score >= ?";
    const params = [args.minScore];
    if (args.category) { sql += ' AND category = ?'; params.push(args.category); }
    sql += ` ORDER BY score DESC, created_at DESC LIMIT ${Math.max(1, Math.min(50, args.limit))}`;
    const candidates = await my.query(sql, params);

    if (candidates.length === 0) {
      console.log(JSON.stringify({ ok: false, error: `没有符合条件的候选主题（score>=${args.minScore}）`, hint: '先运行 npm run run:topic-generation 或降低 --min-score' }, null, 2));
      process.exitCode = 1;
      return;
    }

    if (args.dryRun) {
      console.log(JSON.stringify({ ok: true, dryRun: true, strategy: args.strategy, wouldSelect: candidates.map((c) => ({ topic: c.topic, primaryKeyword: c.primary_keyword, score: c.score })), message: 'dry-run：未写 article_jobs，未更新候选状态' }, null, 2));
      return;
    }

    const now = my.now();
    const engineRunId = process.env.ENGINE_RUN_ID || null;
    const jobs = [];
    for (const c of candidates) {
      const jobId = my.makeId('job');
      await my.insert('article_jobs', {
        id: jobId, engine_run_id: engineRunId, topic_candidate_id: c.id, topic: c.topic,
        primary_keyword: c.primary_keyword, secondary_keywords_json: my.asJson(c.secondary_keywords_json) || [],
        category: c.category, content_angle: c.content_angle, business_angle: c.business_angle,
        source_urls_json: my.asJson(c.source_urls_json) || [], strategy: args.strategy,
        status: 'pending', created_at: now, updated_at: now,
      });
      await my.update('topic_candidates', { status: 'selected', updated_at: now }, 'id = ?', [c.id]);
      const trace = require('./trace_lib');
      await trace.logStatusTransition({ entityType: 'topic_candidate', entityId: c.id, engineRunId, fromStatus: c.status, toStatus: 'selected' });
      await trace.logStatusTransition({ entityType: 'article_job', entityId: jobId, engineRunId, fromStatus: null, toStatus: 'pending' });
      await trace.logWorkflowEvent({ engineRunId, workflowStepId: process.env.WORKFLOW_STEP_ID || null, eventType: 'article_job_created', level: 'info', message: `job 创建: ${c.topic.slice(0, 50)}`, relatedType: 'article_job', relatedId: jobId, data: { strategy: args.strategy, score: c.score } });
      jobs.push({ jobId, topic: c.topic, primaryKeyword: c.primary_keyword });
    }
    console.log(JSON.stringify({ ok: true, jobCount: jobs.length, strategy: args.strategy, jobs }, null, 2));
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
    process.exitCode = 1;
  } finally {
    await my.closePool();
  }
}

main();
