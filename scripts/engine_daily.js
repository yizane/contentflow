#!/usr/bin/env node
// engine_daily.js — Daily Run 入口（幂等控制：一天一个 active daily run）
// 用法:
//   npm run engine:daily                              # mode=start, daily_key=today
//   npm run engine:daily -- --mode retry
//   npm run engine:daily -- --mode rebuild
//   npm run engine:daily -- --mode force [--make-active]
//   npm run engine:daily -- --daily-key 2026-06-05 --actor zane --trigger-source viewer
//   npm run engine:daily -- --plan-only               # 只评估是否允许，不执行不写 engine_runs（写一条 run_actions 评估记录）
const path = require('path');
const { execFileSync } = require('child_process');
const my = require('./mysql_lib');
const rc = require('./run_control_lib');

const ROOT = my.ROOT;
const MODE_ACTION = { start: 'start_daily', retry: 'retry_daily', rebuild: 'rebuild_daily', force: 'force_daily' };

function parseArgs(argv) {
  const args = { mode: 'start', dailyKey: rc.getDailyKey(), actor: 'cli', triggerSource: 'cli', planOnly: false, makeActive: false, extra: [] };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--mode') args.mode = argv[++i];
    else if (argv[i] === '--daily-key') args.dailyKey = argv[++i];
    else if (argv[i] === '--actor') args.actor = argv[++i];
    else if (argv[i] === '--trigger-source') args.triggerSource = argv[++i];
    else if (argv[i] === '--plan-only' || argv[i] === '--dry-run') args.planOnly = true;
    else if (argv[i] === '--make-active') args.makeActive = true;
    else args.extra.push(argv[i]); // 透传给 engine_batch（如 --strategy）
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!MODE_ACTION[args.mode]) {
    console.log(JSON.stringify({ ok: false, error: `mode 非法: ${args.mode}（允许: start/retry/rebuild/force）` }, null, 2));
    process.exit(1);
  }

  const decision = await rc.canStartDaily({ dailyKey: args.dailyKey, mode: args.mode });

  if (args.planOnly) {
    await rc.recordRunAction({
      dailyKey: args.dailyKey, action: MODE_ACTION[args.mode], actor: args.actor, triggerSource: args.triggerSource,
      request: { mode: args.mode, planOnly: true }, result: { allowed: decision.allowed, reason: decision.reason },
      status: decision.allowed ? 'accepted' : 'rejected', errorMessage: decision.allowed ? null : decision.reason,
    });
    console.log(JSON.stringify({ ok: true, planOnly: true, dailyKey: args.dailyKey, mode: args.mode, allowed: decision.allowed, reason: decision.reason, activeRun: decision.activeRun ? { id: decision.activeRun.id, status: decision.activeRun.status } : null, availableActions: decision.availableActions }, null, 2));
    await my.closePool();
    return;
  }

  if (!decision.allowed) {
    await rc.recordRunAction({
      dailyKey: args.dailyKey, action: MODE_ACTION[args.mode], actor: args.actor, triggerSource: args.triggerSource,
      request: { mode: args.mode }, status: 'rejected', errorMessage: decision.reason,
      engineRunId: decision.activeRun ? decision.activeRun.id : null,
    });
    console.log(JSON.stringify({ ok: false, rejected: true, dailyKey: args.dailyKey, mode: args.mode, reason: decision.reason, availableActions: decision.availableActions }, null, 2));
    await my.closePool();
    process.exit(1);
  }

  // 预生成 run id，便于 run_actions / supersede 关联
  const newRunId = my.makeRunId('engine');
  const actionId = await rc.recordRunAction({
    engineRunId: newRunId, dailyKey: args.dailyKey, action: MODE_ACTION[args.mode],
    actor: args.actor, triggerSource: args.triggerSource, request: { mode: args.mode, extra: args.extra }, status: 'running',
  });

  // 旧 active run 处理
  const old = decision.activeRun;
  const archiveWarnings = [];
  if (old && args.mode === 'rebuild') {
    await rc.markRunSuperseded({ oldRunId: old.id, newRunId, reason: 'rebuild' });
    const archived = await rc.archiveRunData({ engineRunId: old.id, supersededBy: newRunId });
    archiveWarnings.push(...archived.warnings);
    console.log(JSON.stringify({ rebuildArchive: archived.counts, warnings: archived.warnings }, null, 2));
  } else if (old && args.mode === 'retry') {
    // retry：新 run 接管 active，旧 run 保留数据（不归档，已成功数据被下游跳过）
    await my.update('engine_runs', { is_active: 0, superseded_by: newRunId }, 'id = ?', [old.id]);
  }
  // force：默认 is_active=false（不抢占当天 active），--make-active 才接管
  const isActive = args.mode === 'force' ? (args.makeActive ? 1 : 0) : 1;
  if (args.mode === 'force' && args.makeActive && old) {
    await my.update('engine_runs', { is_active: 0, superseded_by: newRunId }, 'id = ?', [old.id]);
  }

  await my.closePool(); // 子进程自己连接

  // 执行 engine_batch（传 run 控制参数）
  let exitCode = 0;
  try {
    execFileSync('node', [
      path.join(ROOT, 'scripts', 'engine_batch.js'),
      '--limit', '1', '--min-score', '80', '--run-type', 'daily',
      '--run-id', newRunId, '--daily-key', args.dailyKey, '--run-scope', 'daily',
      '--run-mode', args.mode, '--triggered-by', args.actor, '--trigger-source', args.triggerSource,
      '--is-active', String(isActive),
      ...(args.mode === 'retry' ? ['--retry'] : []),
      ...args.extra,
    ], { stdio: 'inherit', timeout: 60 * 60 * 1000 });
  } catch (err) {
    exitCode = err.status || 1;
  }

  // 回写 run_actions 结果
  const my2 = require('./mysql_lib');
  const run = (await my2.query('SELECT status FROM engine_runs WHERE id = ?', [newRunId]))[0];
  await my2.update('run_actions', {
    status: run && run.status === 'succeeded' ? 'success' : 'failed',
    result_json: JSON.stringify({ engineRunId: newRunId, engineStatus: run ? run.status : 'unknown', archiveWarnings }),
  }, 'id = ?', [actionId]);
  await my2.closePool();
  process.exit(exitCode);
}

main().catch(async (err) => {
  console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
  await my.closePool();
  process.exit(1);
});
