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
const my = require('./lib/mysql_lib');
const rc = require('./lib/run_control_lib');
const logger = require('./lib/logger_lib');
const runtime = require('./lib/workflow_runtime_lib');

const ROOT = my.ROOT;
const MODE_ACTION = { start: 'start_daily', retry: 'retry_daily', rebuild: 'rebuild_daily', force: 'force_daily' };

async function main() {
  const args = runtime.parseDailyArgs(process.argv, { defaultDailyKey: rc.getDailyKey() });
  if (args.engineNow) process.env.ENGINE_NOW = args.engineNow;
  if (!MODE_ACTION[args.mode]) {
    console.log(JSON.stringify({ ok: false, error: `mode 非法: ${args.mode}（允许: start/retry/rebuild/force）` }, null, 2));
    process.exit(1);
  }
  if (args.dryRun) {
    const dryRunId = my.makeRunId('engine');
    const dryRunIsActive = args.mode === 'force' ? (args.makeActive ? 1 : 0) : 1;
    const invocation = runtime.buildDailyBatchInvocation({
      args,
      runId: dryRunId,
      isActive: dryRunIsActive,
      scriptPath: path.join(ROOT, 'scripts', 'engine_batch.js'),
    });
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      dailyKey: args.dailyKey,
      mode: args.mode,
      engineNow: args.engineNow,
      targetReady: args.targetReady,
      maxAttempts: args.maxAttempts,
      batchArgv: invocation.argv.slice(1),
      message: 'dry-run：未评估 run_control，未写 run_actions，未执行 batch',
    }, null, 2));
    await my.closePool();
    return;
  }

  const decision = await rc.canStartDaily({ dailyKey: args.dailyKey, mode: args.mode });
  logger.log(`engine:daily mode=${args.mode} dailyKey=${args.dailyKey} → ${decision.allowed ? '允许' : '拒绝'}: ${decision.reason}`);

  if (args.planOnly) {
    await rc.recordRunAction({
      dailyKey: args.dailyKey, action: MODE_ACTION[args.mode], actor: args.actor, triggerSource: args.triggerSource,
      request: { mode: args.mode, planOnly: true, asOfDate: args.asOfDate, targetReady: args.targetReady, maxAttempts: args.maxAttempts }, result: { allowed: decision.allowed, reason: decision.reason },
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
    actor: args.actor, triggerSource: args.triggerSource,
    request: { mode: args.mode, extra: args.extra, asOfDate: args.asOfDate, targetReady: args.targetReady, maxAttempts: args.maxAttempts },
    status: 'running',
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
    const invocation = runtime.buildDailyBatchInvocation({
      args,
      runId: newRunId,
      isActive,
      scriptPath: path.join(ROOT, 'scripts', 'engine_batch.js'),
    });
    execFileSync(invocation.argv[0], invocation.argv.slice(1), { stdio: 'inherit', timeout: 60 * 60 * 1000, env: invocation.env });
  } catch (err) {
    exitCode = err.status || 1;
  }

  // 回写 run_actions 结果
  const my2 = require('./lib/mysql_lib');
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
