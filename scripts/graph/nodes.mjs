import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const my = require('../lib/mysql_lib');
const trace = require('../lib/trace_lib');
const { makeStepRunner } = require('../lib/workflow_step_runner_lib');

export const STEP_SPECS = {
  collectSources: { name: 'sources:collect', script: 'pipeline/sources_collect.js', args: () => [] },
  generateTopics: { name: 'topics:generate', script: 'pipeline/topics_generate.js', args: () => [] },
  createJobs: {
    name: 'jobs:create',
    script: 'pipeline/jobs_create.js',
    args: (s) => ['--limit', String(s.limit), '--min-score', String(s.minScore), '--strategy', s.strategy],
  },
  runJobs: {
    name: 'jobs:run',
    script: 'pipeline/jobs_run.js',
    args: (s) => ['--limit', String(s.limit)],
  },
  factcheck: {
    name: 'factcheck:run',
    script: 'pipeline/factcheck_run.js',
    args: (s) => ['--limit', String(Math.max(s.limit, s.targetReady))],
    skipWhen: (s) => (s.lastGeneratedOk || 0) <= 0,
  },
  scoreSeoGeo: {
    name: 'score:seo-geo',
    script: 'pipeline/score_seo_geo.js',
    args: (s) => ['--status', 'ready_for_review', '--strategy', s.strategy],
    skipWhen: (s) => s.skipSeoGeoScore || (s.readyCount || 0) <= 0,
  },
  channels: {
    name: 'channels:generate',
    script: 'pipeline/channels_generate.js',
    args: () => ['--status', 'ready_for_review', '--missing-only'],
    skipWhen: (s) => (s.readyCount || 0) <= 0,
  },
  dbList: { name: 'db:list', script: 'tools/db_list.js', args: () => ['--limit', '10'] },
};

export function makeGraphNodeContext({ stepOrderRef }) {
  return {
    runStep: makeStepRunner({ root: my.ROOT, trace, stepOrderRef }),
  };
}

export function isCandidateExhausted(outcome) {
  const msg = String((outcome && outcome.result && outcome.result.error) || (outcome && outcome.error) || '');
  return /没有符合条件的候选主题|高分候选全部被组合节流/.test(msg);
}

function failedItems(results = [], format) {
  return results.filter((r) => !r.ok).map(format);
}

export function makeStepNode(spec, ctx) {
  return async function stepNode(state) {
    if (spec.skipWhen && spec.skipWhen(state)) {
      await ctx.runStep(spec.name, '', [], state.engineRunId, { skipped: true });
      return {};
    }

    const outcome = await ctx.runStep(spec.name, spec.script, spec.args(state), state.engineRunId);
    const result = outcome.result || {};

    if (!outcome.ok && spec.name === 'jobs:create' && isCandidateExhausted(outcome)) {
      return {
        noMoreCandidates: true,
        warnings: [`jobs:create: ${outcome.error}`],
      };
    }

    if (!outcome.ok && !outcome.result) {
      return { errors: [`${spec.name}: ${outcome.error}`] };
    }

    if (spec.name === 'sources:collect') {
      return {
        topicsCollected: result.summary ? result.summary.total || 0 : 0,
        warnings: (result.warnings || []).slice(0, 8),
      };
    }

    if (spec.name === 'topics:generate') {
      return {
        dedupeRejected: result.dedupeRejected || 0,
        warnings: (result.warnings || []).slice(0, 8),
      };
    }

    if (spec.name === 'jobs:create') {
      const jobCount = result.jobCount || (result.selected ? result.selected.length : 0) || 0;
      return {
        topicsSelected: (state.topicsSelected || 0) + jobCount,
        noMoreCandidates: jobCount === 0,
        warnings: jobCount === 0 ? ['jobs:create 未选出候选，停止补位循环'] : [],
      };
    }

    if (spec.name === 'jobs:run') {
      const attempted = (result.succeeded || 0) + (result.failed || 0);
      const generatedOk = result.succeeded || 0;
      return {
        attempts: (state.attempts || 0) + attempted,
        lastAttempted: attempted,
        lastGeneratedOk: generatedOk,
        noMoreCandidates: attempted === 0 ? true : state.noMoreCandidates,
        articlesGenerated: (state.articlesGenerated || 0) + attempted,
        articlesValidated: (state.articlesValidated || 0) + generatedOk,
        warnings: [
          ...(attempted === 0 ? ['jobs:run 未处理任何 job，停止补位'] : []),
          ...failedItems(result.results || [], (r) => `job ${r.jobId}: ${(r.failures || []).join('; ').slice(0, 200)}`),
        ],
      };
    }

    if (spec.name === 'factcheck:run') {
      return {
        factChecksCompleted: (state.factChecksCompleted || 0) + (result.succeeded || 0),
        errors: failedItems(result.results || [], (r) => `fact check ${r.articleId}: ${r.error}`),
      };
    }

    if (spec.name === 'score:seo-geo') {
      return {
        seoGeoScored: result.scored || 0,
        errors: outcome.ok ? [] : [`score:seo-geo: ${outcome.error || '部分失败'}`],
      };
    }

    if (spec.name === 'channels:generate') {
      return {
        channelOutputsGenerated: result.channelOutputsGenerated || 0,
        errors: outcome.ok ? [] : [`channels:generate: ${outcome.error || '部分失败'}`],
      };
    }

    return {};
  };
}

export async function refreshArticleCounts(state) {
  const ready = (await my.query("SELECT COUNT(*) c FROM articles WHERE engine_run_id = ? AND status = 'ready_for_review'", [state.engineRunId]))[0].c;
  const qualityFailed = (await my.query("SELECT COUNT(*) c FROM articles WHERE engine_run_id = ? AND status = 'needs_quality_revision'", [state.engineRunId]))[0].c;
  return { readyCount: ready, qualityFailedCount: qualityFailed };
}
