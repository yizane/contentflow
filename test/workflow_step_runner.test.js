const test = require('node:test');
const assert = require('node:assert/strict');
const runner = require('../scripts/lib/workflow_step_runner_lib');

test('lastJson parses the final JSON object from mixed stdout', () => {
  const parsed = runner.lastJson('log line\n{"ok":true,"count":2}\n');
  assert.deepEqual(parsed, { ok: true, count: 2 });
});

test('lastJson parses JSON object without a leading newline', () => {
  const parsed = runner.lastJson('{"ok":true,"count":3}');
  assert.deepEqual(parsed, { ok: true, count: 3 });
});

test('lastJson returns null for non-json stdout', () => {
  assert.equal(runner.lastJson('plain text'), null);
});

test('stepKeyFromName maps colon names to underscore keys', () => {
  assert.equal(runner.stepKeyFromName('sources:collect'), 'sources_collect');
  assert.equal(runner.stepKeyFromName('score:seo-geo'), 'score_seo-geo');
});
