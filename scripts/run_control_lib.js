// run_control_lib.js — Daily Run 控制：一天默认一个 active daily run；retry/rebuild/force 显式处理
const my = require('./mysql_lib');
const trace = require('./trace_lib');

function getDailyKey(date = new Date()) {
  // 本地日期（运营按本地日历理解"今天"）
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

// 今日（或指定 dailyKey）的 active daily run 状态
async function getTodayRunStatus({ dailyKey = getDailyKey(), scope = 'daily' } = {}) {
  const runs = await my.query(
    'SELECT * FROM engine_runs WHERE daily_key = ? AND run_scope = ? ORDER BY is_active DESC, started_at DESC LIMIT 5',
    [dailyKey, scope]
  );
  const active = runs.find((r) => r.is_active);
  return { dailyKey, scope, activeRun: active || null, allRuns: runs };
}

// completed 口径：succeeded 视为完成；partial/failed 可 retry；running 进行中
function isCompleted(status) {
  return status === 'succeeded';
}
function isRetryable(status) {
  return ['failed', 'partial'].includes(status);
}

/**
 * 判定某 mode 是否允许执行。
 * @returns {{allowed: boolean, reason: string, activeRun: object|null, availableActions: object}}
 */
async function canStartDaily({ dailyKey = getDailyKey(), mode = 'start' } = {}) {
  const { activeRun } = await getTodayRunStatus({ dailyKey });
  const actions = {
    start: !activeRun,
    retry: !!activeRun && isRetryable(activeRun.status),
    rebuild: !!activeRun,
    force: true,
  };
  let allowed;
  let reason;
  if (mode === 'start') {
    if (!activeRun) { allowed = true; reason = `当天（${dailyKey}）无 active daily run，可以 start`; }
    else if (activeRun.status === 'running') { allowed = false; reason = `当天已有 running 的 daily run（${activeRun.id}），请等待完成`; }
    else if (isCompleted(activeRun.status)) { allowed = false; reason = `当天 daily run 已完成（${activeRun.id}），重复 start 不会创建新数据；如需重跑请用 rebuild`; }
    else { allowed = false; reason = `当天 daily run 状态为 ${activeRun.status}（${activeRun.id}），请用 retry 或 rebuild`; }
  } else if (mode === 'retry') {
    if (!activeRun) { allowed = false; reason = `当天没有 daily run，请先 start`; }
    else if (isCompleted(activeRun.status)) { allowed = false; reason = `当天 daily run 已完成，无需 retry；如需重跑请用 rebuild`; }
    else if (activeRun.status === 'running') { allowed = false; reason = `当天 daily run 仍在 running，不能 retry`; }
    else { allowed = true; reason = `active run 状态 ${activeRun.status}，允许 retry（跳过已成功数据）`; }
  } else if (mode === 'rebuild') {
    allowed = true;
    reason = activeRun ? `将归档旧 run ${activeRun.id} 并完整重跑` : `当天无旧 run，rebuild 等价于 start`;
  } else if (mode === 'force') {
    allowed = true;
    reason = 'force 模式：创建额外 run（默认 is_active=false，高级操作）';
  } else {
    allowed = false;
    reason = `未知 mode: ${mode}`;
  }
  return { allowed, reason, activeRun, availableActions: actions };
}

async function recordRunAction({ engineRunId, dailyKey, action, actor, triggerSource, request, result, status, errorMessage }) {
  const id = my.makeId('runact');
  await my.insert('run_actions', {
    id, engine_run_id: engineRunId || null, daily_key: dailyKey || null, action,
    actor: actor || 'cli', trigger_source: triggerSource || 'cli',
    request_json: request || null, result_json: result || null, status,
    error_message: errorMessage ? String(errorMessage).slice(0, 900) : null, created_at: my.now(),
  });
  return id;
}

async function markRunSuperseded({ oldRunId, newRunId, reason }) {
  await my.update('engine_runs', { is_active: 0, status: 'superseded', superseded_by: newRunId }, 'id = ?', [oldRunId]);
  await trace.logStatusTransition({ entityType: 'engine_run', entityId: oldRunId, engineRunId: newRunId, fromStatus: 'active', toStatus: 'superseded', reason: reason || `superseded by ${newRunId}`, actor: 'run_control' });
}

/**
 * rebuild 归档：不物理删除，全部标记归档。
 * approved_for_publish / published 文章不动，输出 warning。
 */
async function archiveRunData({ engineRunId, supersededBy }) {
  const warnings = [];
  const now = my.now();
  const counts = { topicCandidates: 0, articleJobs: 0, articles: 0, versions: 0, packages: 0, channels: 0 };

  // topic_candidates → archived（generated 的保留原状态，candidate/selected 归档）
  const tcs = await my.query("SELECT id, status FROM topic_candidates WHERE engine_run_id = ? AND status IN ('candidate', 'selected')", [engineRunId]);
  for (const tc of tcs) {
    await my.update('topic_candidates', { status: 'archived', updated_at: now }, 'id = ?', [tc.id]);
    await trace.logStatusTransition({ entityType: 'topic_candidate', entityId: tc.id, engineRunId: supersededBy, fromStatus: tc.status, toStatus: 'archived', reason: 'rebuild archive', actor: 'run_control' });
    counts.topicCandidates++;
  }

  // article_jobs：pending/running/failed → cancelled
  const jobs = await my.query("SELECT id, status FROM article_jobs WHERE engine_run_id = ? AND status IN ('pending', 'running', 'failed')", [engineRunId]);
  for (const j of jobs) {
    await my.update('article_jobs', { status: 'cancelled', updated_at: now }, 'id = ?', [j.id]);
    await trace.logStatusTransition({ entityType: 'article_job', entityId: j.id, engineRunId: supersededBy, fromStatus: j.status, toStatus: 'cancelled', reason: 'rebuild archive', actor: 'run_control' });
    counts.articleJobs++;
  }

  // articles：非 approved_for_publish/published → archived（连带版本/包/渠道）
  const articles = await my.query('SELECT id, status FROM articles WHERE engine_run_id = ?', [engineRunId]);
  for (const a of articles) {
    if (['approved_for_publish', 'published'].includes(a.status)) {
      warnings.push(`文章 ${a.id} 状态为 ${a.status}，不自动归档（需人工决定）`);
      continue;
    }
    await my.update('articles', { status: 'archived', updated_at: now }, 'id = ?', [a.id]);
    await trace.logStatusTransition({ entityType: 'article', entityId: a.id, engineRunId: supersededBy, fromStatus: a.status, toStatus: 'archived', reason: 'rebuild archive', actor: 'run_control' });
    counts.articles++;

    const vers = await my.query("SELECT id, status FROM article_versions WHERE article_id = ? AND status != 'archived'", [a.id]);
    for (const v of vers) {
      await my.update('article_versions', { status: 'archived', updated_at: now }, 'id = ?', [v.id]);
      counts.versions++;
    }
    const pkgs = await my.query("SELECT id, status FROM publish_packages WHERE article_id = ? AND status != 'superseded'", [a.id]);
    for (const p of pkgs) {
      await my.update('publish_packages', { status: 'superseded', updated_at: now }, 'id = ?', [p.id]);
      await trace.logStatusTransition({ entityType: 'publish_package', entityId: p.id, engineRunId: supersededBy, fromStatus: p.status, toStatus: 'superseded', reason: 'rebuild archive', actor: 'run_control' });
      counts.packages++;
    }
    const chs = await my.query("SELECT id, status FROM channel_outputs WHERE article_id = ? AND status != 'archived'", [a.id]);
    for (const c of chs) {
      await my.update('channel_outputs', { status: 'archived', updated_at: now }, 'id = ?', [c.id]);
      counts.channels++;
    }
  }

  return { counts, warnings };
}

module.exports = { getDailyKey, getTodayRunStatus, canStartDaily, recordRunAction, markRunSuperseded, archiveRunData, isCompleted, isRetryable };
