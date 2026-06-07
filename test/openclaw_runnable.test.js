const test = require('node:test');
const assert = require('node:assert/strict');

test('provider runnable accepts provider-compatible task input', async () => {
  const mod = await import('../scripts/graph/openclaw_runnable.mjs');
  const runnable = mod.createProviderRunnable({
    runTask: async ({ taskType, message, sessionKey, timeoutSec }) => ({
      ok: true,
      taskType,
      visibleText: JSON.stringify({ ok: true, message, sessionKey, timeoutSec }),
      raw: { mocked: true },
      durationMs: 1,
    }),
  });

  const out = await runnable.invoke({
    taskType: 'fact_check',
    message: 'hello',
    sessionKey: 'test-session',
    timeoutSec: 10,
  });

  assert.equal(out.ok, true);
  assert.equal(out.taskType, 'fact_check');
  assert.equal(out.visibleText.includes('hello'), true);
  assert.equal(out.visibleText.includes('test-session'), true);
});
