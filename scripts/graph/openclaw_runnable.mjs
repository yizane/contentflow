import { createRequire } from 'node:module';
import { RunnableLambda } from '@langchain/core/runnables';

const require = createRequire(import.meta.url);
const providers = require('../lib/providers');

export function createProviderRunnable(adapter = providers) {
  return RunnableLambda.from(async (input) => {
    const taskType = input.taskType || 'fact_check';
    const message = input.message || '';
    const sessionKey = input.sessionKey || `agent:graph:${Date.now()}`;
    const timeoutSec = input.timeoutSec || 900;
    const route = input.route || null;
    return adapter.runTask({ taskType, message, sessionKey, timeoutSec, route });
  });
}
