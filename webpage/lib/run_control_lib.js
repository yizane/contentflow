// run_control_lib.js — Viewer-side daily run status helpers.
const my = require('./mysql_lib');

function getDailyKey(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

async function getTodayRunStatus({ dailyKey = getDailyKey(), scope = 'daily' } = {}) {
  const runs = await my.query(
    'SELECT * FROM engine_runs WHERE daily_key = ? AND run_scope = ? ORDER BY is_active DESC, started_at DESC LIMIT 5',
    [dailyKey, scope]
  );
  const activeRun = runs.find((row) => row.is_active) || null;
  return { dailyKey, scope, activeRun, allRuns: runs };
}

function isCompleted(status) {
  return status === 'succeeded';
}

function isRetryable(status) {
  return ['failed', 'partial'].includes(status);
}

async function canStartDaily({ dailyKey = getDailyKey(), mode = 'start' } = {}) {
  const { activeRun } = await getTodayRunStatus({ dailyKey });
  const availableActions = {
    start: !activeRun,
    retry: !!activeRun && isRetryable(activeRun.status),
    rebuild: !!activeRun,
    force: true,
  };
  if (mode === 'start') {
    if (!activeRun) return { allowed: true, reason: `当天（${dailyKey}）无 active daily run，可以 start`, activeRun, availableActions };
    if (activeRun.status === 'running') return { allowed: false, reason: `当天已有 running 的 daily run（${activeRun.id}），请等待完成`, activeRun, availableActions };
    if (isCompleted(activeRun.status)) return { allowed: false, reason: `当天 daily run 已完成（${activeRun.id}），重复 start 不会创建新数据；如需重跑请用 rebuild`, activeRun, availableActions };
    return { allowed: false, reason: `当天 daily run 状态为 ${activeRun.status}（${activeRun.id}），请用 retry 或 rebuild`, activeRun, availableActions };
  }
  if (mode === 'retry') {
    if (!activeRun) return { allowed: false, reason: '当天没有 daily run，请先 start', activeRun, availableActions };
    if (isCompleted(activeRun.status)) return { allowed: false, reason: '当天 daily run 已完成，无需 retry；如需重跑请用 rebuild', activeRun, availableActions };
    if (activeRun.status === 'running') return { allowed: false, reason: '当天 daily run 仍在 running，不能 retry', activeRun, availableActions };
    return { allowed: true, reason: `active run 状态 ${activeRun.status}，允许 retry（跳过已成功数据）`, activeRun, availableActions };
  }
  if (mode === 'rebuild') {
    return { allowed: true, reason: activeRun ? `将归档旧 run ${activeRun.id} 并完整重跑` : '当天无旧 run，rebuild 等价于 start', activeRun, availableActions };
  }
  if (mode === 'force') {
    return { allowed: true, reason: 'force 模式：创建额外 run（默认 is_active=false，高级操作）', activeRun, availableActions };
  }
  return { allowed: false, reason: `未知 mode: ${mode}`, activeRun, availableActions };
}

async function recordRunAction({ engineRunId, dailyKey, action, actor, triggerSource, request, result, status, errorMessage }) {
  const id = my.makeId('runact');
  await my.insert('run_actions', {
    id,
    engine_run_id: engineRunId || null,
    daily_key: dailyKey || null,
    action,
    actor: actor || 'viewer',
    trigger_source: triggerSource || 'viewer',
    request_json: request || null,
    result_json: result || null,
    status,
    error_message: errorMessage ? String(errorMessage).slice(0, 900) : null,
    created_at: my.now(),
  });
  return id;
}

module.exports = { getDailyKey, getTodayRunStatus, canStartDaily, recordRunAction, isCompleted, isRetryable };
