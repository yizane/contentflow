#!/usr/bin/env node
// content_classify.js — 内容分类 CLI（规则 + OpenClaw，结果写 MySQL）
// 用法:
//   npm run content:classify -- --entity source_items --limit 50
//   npm run content:classify -- --entity topic_candidates --limit 50
//   npm run content:classify -- --entity articles --limit 50
//   npm run content:classify -- --all --limit 100
// 可选: --force（重分类已有分类的行）  --no-ai（仅规则）  --ai-batch 15  --max-ai-calls 10
const my = require('../lib/mysql_lib');
const { classifyEntity, ENTITIES } = require('../lib/classify_lib');

function parseArgs(argv) {
  const args = { entity: null, all: false, limit: 100, force: false, noAi: false, aiBatch: 15, maxAiCalls: Infinity };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--entity') args.entity = argv[++i];
    else if (argv[i] === '--all') args.all = true;
    else if (argv[i] === '--limit') args.limit = parseInt(argv[++i], 10) || 100;
    else if (argv[i] === '--force') args.force = true;
    else if (argv[i] === '--no-ai') args.noAi = true;
    else if (argv[i] === '--ai-batch') args.aiBatch = Math.max(1, Math.min(30, parseInt(argv[++i], 10) || 15));
    else if (argv[i] === '--max-ai-calls') args.maxAiCalls = parseInt(argv[++i], 10) || Infinity;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const entities = args.all ? Object.keys(ENTITIES) : args.entity ? [args.entity] : null;
  if (!entities) {
    console.log(JSON.stringify({ ok: false, error: '用法: --entity <source_items|topic_candidates|articles> 或 --all，配合 --limit N' }, null, 2));
    process.exit(1);
  }
  for (const e of entities) {
    if (!ENTITIES[e]) {
      console.log(JSON.stringify({ ok: false, error: `entity 非法: ${e}（支持 ${Object.keys(ENTITIES).join(' / ')}）` }, null, 2));
      process.exit(1);
    }
  }

  const engineRunId = process.env.ENGINE_RUN_ID || null;
  try {
    const results = [];
    for (const entity of entities) {
      const r = await classifyEntity({
        entity, limit: args.limit, force: args.force, engineRunId,
        aiBatch: args.aiBatch, maxAiCalls: args.maxAiCalls, noAi: args.noAi,
      });
      results.push(r);
    }
    const totals = results.reduce((acc, r) => ({
      total: acc.total + r.total, classified: acc.classified + r.classified,
      byRules: acc.byRules + r.byRules, byAi: acc.byAi + r.byAi, failed: acc.failed + r.failed,
    }), { total: 0, classified: 0, byRules: 0, byAi: 0, failed: 0 });
    console.log(JSON.stringify({
      ok: true, totals,
      results: results.map((r) => ({ ...r, lowConfidence: r.lowConfidence.slice(0, 10) })),
      hint: totals.failed > 0 ? '失败条目（规则无信号且 AI 不可用）可重跑：npm run content:classify -- --all' : undefined,
    }, null, 2));
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
    process.exitCode = 1;
  } finally {
    await my.closePool();
  }
}

main();
