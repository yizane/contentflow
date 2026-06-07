const test = require('node:test');
const assert = require('node:assert/strict');

test('graph state defaults expose the required counters', async () => {
  const mod = await import('../scripts/graph/graph_state.mjs');
  const state = mod.initialGraphState({ engineRunId: 'run_test', limit: 1, targetReady: 5 });
  assert.equal(state.engineRunId, 'run_test');
  assert.equal(state.limit, 1);
  assert.equal(state.targetReady, 5);
  assert.equal(state.readyCount, 0);
  assert.equal(state.noMoreCandidates, false);
  assert.deepEqual(state.warnings, []);
  assert.deepEqual(state.errors, []);
});

test('graph dry-run plan is stable', async () => {
  const mod = await import('../scripts/graph/engine_graph.mjs');
  const plan = mod.buildGraphDryRunPlan({ limit: 1, targetReady: 5, maxAttempts: 15, strategy: 'balanced', skipSeoGeoScore: false });
  assert.deepEqual(plan.map((x) => x.name), [
    'sources:collect',
    'topics:generate',
    'quota:loop',
    'jobs:create',
    'jobs:run',
    'factcheck:run',
    'score:seo-geo',
    'channels:generate',
    'db:list',
  ]);
});

test('node specs map graph nodes to existing pipeline scripts', async () => {
  const mod = await import('../scripts/graph/nodes.mjs');
  assert.equal(mod.STEP_SPECS.collectSources.script, 'pipeline/sources_collect.js');
  assert.equal(mod.STEP_SPECS.generateTopics.script, 'pipeline/topics_generate.js');
  assert.equal(mod.STEP_SPECS.createJobs.script, 'pipeline/jobs_create.js');
  assert.equal(mod.STEP_SPECS.runJobs.script, 'pipeline/jobs_run.js');
  assert.equal(mod.STEP_SPECS.factcheck.script, 'pipeline/factcheck_run.js');
  assert.equal(mod.STEP_SPECS.scoreSeoGeo.script, 'pipeline/score_seo_geo.js');
  assert.equal(mod.STEP_SPECS.channels.script, 'pipeline/channels_generate.js');
});

test('candidate exhaustion is a business stop condition', async () => {
  const mod = await import('../scripts/graph/nodes.mjs');
  assert.equal(mod.isCandidateExhausted({ error: '没有符合条件的候选主题（score>=80）' }), true);
  assert.equal(mod.isCandidateExhausted({ error: '高分候选全部被组合节流（deferred 12 个）' }), true);
  assert.equal(mod.isCandidateExhausted({ error: '数据库连接失败' }), false);
});
