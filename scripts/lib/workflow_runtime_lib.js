// workflow_runtime_lib.js — 纯 workflow 运行时约定（参数、模拟时钟、dry-run 计划）

const DEFAULT_TARGET_READY = 5;
const DEFAULT_MAX_ATTEMPTS = 15;
const STRATEGIES = ['balanced', 'seo_first', 'geo_first'];

function positiveInt(v, fallback, { min = 1, max = 999 } = {}) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.min(max, n);
}

function assertDateKey(s, label = 'date') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) {
    throw new Error(`${label} 必须是 YYYY-MM-DD`);
  }
  return s;
}

function normalizeEngineNow(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const isoLike = dateOnly ? `${raw}T00:00:00.000Z` : raw.includes('T') ? raw : raw.replace(' ', 'T');
  const d = new Date(isoLike);
  if (Number.isNaN(d.getTime())) throw new Error(`ENGINE_NOW/--as-of-date 非法: ${value}`);
  return d.toISOString().slice(0, 23) + 'Z';
}

function engineNowDate(value = process.env.ENGINE_NOW) {
  const normalized = normalizeEngineNow(value);
  return normalized ? new Date(normalized) : new Date();
}

function mysqlDateTimeFromDate(date) {
  return date.toISOString().slice(0, 23).replace('T', ' ');
}

function mysqlDateTime(value = process.env.ENGINE_NOW) {
  return mysqlDateTimeFromDate(engineNowDate(value));
}

function dailyKeyFromDate(date) {
  return date.toISOString().slice(0, 10);
}

function parseDailyArgs(argv, { defaultDailyKey = null } = {}) {
  const args = {
    mode: 'start',
    dailyKey: defaultDailyKey || dailyKeyFromDate(new Date()),
    actor: 'cli',
    triggerSource: 'cli',
    planOnly: false,
    dryRun: false,
    makeActive: false,
    extra: [],
    asOfDate: null,
    engineNow: null,
    targetReady: DEFAULT_TARGET_READY,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
  };
  let dailyKeyExplicit = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--mode') args.mode = argv[++i];
    else if (argv[i] === '--daily-key') { args.dailyKey = assertDateKey(argv[++i], '--daily-key'); dailyKeyExplicit = true; }
    else if (argv[i] === '--actor') args.actor = argv[++i];
    else if (argv[i] === '--trigger-source') args.triggerSource = argv[++i];
    else if (argv[i] === '--plan-only') args.planOnly = true;
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--make-active') args.makeActive = true;
    else if (argv[i] === '--as-of-date') args.asOfDate = assertDateKey(argv[++i], '--as-of-date');
    else if (argv[i] === '--target-ready') args.targetReady = positiveInt(argv[++i], DEFAULT_TARGET_READY, { min: 1, max: 50 });
    else if (argv[i] === '--max-attempts') args.maxAttempts = positiveInt(argv[++i], DEFAULT_MAX_ATTEMPTS, { min: 1, max: 200 });
    else args.extra.push(argv[i]);
  }
  if (args.asOfDate) {
    args.engineNow = normalizeEngineNow(args.asOfDate);
    if (!dailyKeyExplicit) args.dailyKey = args.asOfDate;
    if (args.dailyKey !== args.asOfDate) {
      throw new Error(`--daily-key (${args.dailyKey}) 必须与 --as-of-date (${args.asOfDate}) 一致`);
    }
  }
  return args;
}

function parseBatchArgs(argv) {
  const args = {
    limit: 1,
    minScore: 80,
    runType: 'batch',
    force: false,
    strategy: 'balanced',
    skipSeoGeoScore: false,
    dryRun: false,
    runId: null,
    dailyKey: null,
    runScope: 'batch',
    runMode: 'start',
    triggeredBy: 'cli',
    triggerSource: 'cli',
    isActive: 1,
    retry: false,
    targetReady: null,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    asOfDate: null,
    engineNow: process.env.ENGINE_NOW ? normalizeEngineNow(process.env.ENGINE_NOW) : null,
  };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--limit') args.limit = positiveInt(argv[++i], 1, { min: 1, max: 200 });
    else if (argv[i] === '--min-score') args.minScore = positiveInt(argv[++i], 80, { min: 0, max: 100 });
    else if (argv[i] === '--run-type') args.runType = argv[++i];
    else if (argv[i] === '--force') args.force = true;
    else if (argv[i] === '--strategy') args.strategy = argv[++i];
    else if (argv[i] === '--skip-seo-geo-score') args.skipSeoGeoScore = true;
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--run-id') args.runId = argv[++i];
    else if (argv[i] === '--daily-key') args.dailyKey = assertDateKey(argv[++i], '--daily-key');
    else if (argv[i] === '--run-scope') args.runScope = argv[++i];
    else if (argv[i] === '--run-mode') args.runMode = argv[++i];
    else if (argv[i] === '--triggered-by') args.triggeredBy = argv[++i];
    else if (argv[i] === '--trigger-source') args.triggerSource = argv[++i];
    else if (argv[i] === '--is-active') args.isActive = positiveInt(argv[++i], 1, { min: 0, max: 1 });
    else if (argv[i] === '--retry') args.retry = true;
    else if (argv[i] === '--target-ready') args.targetReady = positiveInt(argv[++i], DEFAULT_TARGET_READY, { min: 1, max: 50 });
    else if (argv[i] === '--max-attempts') args.maxAttempts = positiveInt(argv[++i], DEFAULT_MAX_ATTEMPTS, { min: 1, max: 200 });
    else if (argv[i] === '--as-of-date') {
      args.asOfDate = assertDateKey(argv[++i], '--as-of-date');
      args.engineNow = normalizeEngineNow(args.asOfDate);
      if (!args.dailyKey) args.dailyKey = args.asOfDate;
    }
  }
  if (!STRATEGIES.includes(args.strategy)) throw new Error(`strategy 非法: ${args.strategy}`);
  if (args.asOfDate && args.dailyKey && args.dailyKey !== args.asOfDate) {
    throw new Error(`--daily-key (${args.dailyKey}) 必须与 --as-of-date (${args.asOfDate}) 一致`);
  }
  return args;
}

function resolvedTargetReady(args) {
  return args.targetReady || args.limit;
}

function buildBatchDryRunPlan(args, { reusableJobs = null } = {}) {
  const targetReady = resolvedTargetReady(args);
  const retryReusableJobs = args.retry ? reusableJobs : null;
  const steps = [];
  if (args.retry) steps.push('retry:check-reusable-jobs');
  if (!(args.retry && reusableJobs > 0)) {
    steps.push('sources:collect');
    steps.push('topics:generate');
    steps.push(`quota:loop target-ready ${targetReady} max-attempts ${args.maxAttempts}`);
    steps.push(`jobs:create --limit ${args.limit} --strategy ${args.strategy}`);
  }
  steps.push('jobs:run');
  steps.push('factcheck:run');
  if (!args.skipSeoGeoScore) steps.push('score:seo-geo --status ready_for_review');
  steps.push('channels:generate --status ready_for_review --missing-only');
  steps.push('db:list');
  return {
    limit: args.limit,
    targetReady,
    maxAttempts: args.maxAttempts,
    minScore: args.minScore,
    strategy: args.strategy,
    retry: args.retry,
    retryReusableJobs,
    engineNow: args.engineNow,
    steps,
  };
}

function buildDailyBatchInvocation({ args, runId, isActive, scriptPath }) {
  const argv = [
    'node',
    scriptPath,
    '--limit', '1',
    '--min-score', '80',
    '--target-ready', String(args.targetReady),
    '--max-attempts', String(args.maxAttempts),
    '--run-type', 'daily',
    '--run-id', runId,
    '--daily-key', args.dailyKey,
    '--run-scope', 'daily',
    '--run-mode', args.mode,
    '--triggered-by', args.actor,
    '--trigger-source', args.triggerSource,
    '--is-active', String(isActive),
    ...(args.engineNow ? ['--as-of-date', args.dailyKey] : []),
    ...(args.mode === 'retry' ? ['--retry'] : []),
    ...args.extra,
  ];
  return { argv, env: args.engineNow ? { ...process.env, ENGINE_NOW: args.engineNow } : { ...process.env } };
}

function decideReadyGate({ intendedStatus, score, scoreOk = true, minScore = 80 }) {
  if (intendedStatus !== 'ready_for_review') return { status: intendedStatus, gated: false, score };
  if (!scoreOk || score == null) {
    return { status: 'needs_quality_revision', gated: true, score: null, reason: '文章质量主评分失败，不能进入终审' };
  }
  if (score < minScore) {
    return { status: 'needs_quality_revision', gated: true, score, reason: `文章质量主评分 ${score} < ${minScore}（SEO/GEO 不能覆盖质量不足）` };
  }
  return { status: intendedStatus, gated: false, score };
}

function businessOutcome({ readyCount, targetReady, technicalFailed = false }) {
  if (technicalFailed) return 'technical_failed';
  if (readyCount >= targetReady) return 'target_met';
  if (readyCount > 0) return 'partial';
  return 'no_ready_articles';
}

module.exports = {
  DEFAULT_TARGET_READY,
  DEFAULT_MAX_ATTEMPTS,
  STRATEGIES,
  positiveInt,
  normalizeEngineNow,
  engineNowDate,
  mysqlDateTime,
  mysqlDateTimeFromDate,
  dailyKeyFromDate,
  parseDailyArgs,
  parseBatchArgs,
  resolvedTargetReady,
  buildBatchDryRunPlan,
  buildDailyBatchInvocation,
  decideReadyGate,
  businessOutcome,
};
