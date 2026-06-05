// providers/codex_cli.js — OpenAI Codex 本地 CLI 执行器【预留 · 实验性，未在生产验证】
// 启用：models.yaml providers.codex_cli.enabled: true；task 节点 provider: codex_cli
const { execFileSync } = require('child_process');
const logger = require('../logger_lib');

async function run({ providerCfg, model, message, timeoutSec = 900 }) {
  const command = providerCfg.command || 'codex';
  // codex exec：非交互执行；--json 输出 JSONL 事件流，取 agent_message 文本
  const args = ['exec', message, '-s', 'read-only', '--json'];
  if (model) args.push('-m', model);
  const started = Date.now();
  logger.log(`Codex 调用（实验性）: prompt ${message.length} 字符`, { name: 'codex' });
  let stdout = '';
  try {
    stdout = execFileSync(command, args, {
      encoding: 'utf8', timeout: (timeoutSec + 60) * 1000, maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    return {
      ok: false,
      error: `codex CLI 调用失败: ${(err.stderr || err.stdout || err.message || '').toString().slice(0, 600)}`,
      visibleText: null, raw: null, durationMs: Date.now() - started,
    };
  }
  // JSONL：逐行解析，拼接 agent_message
  const texts = [];
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const obj = JSON.parse(t);
      const item = obj.item || obj;
      if ((item.type === 'agent_message' || obj.type === 'agent_message') && item.text) texts.push(item.text);
    } catch (_) { /* ignore */ }
  }
  const visibleText = texts.join('\n') || stdout.trim() || null;
  return { ok: !!visibleText, error: visibleText ? null : 'codex 输出中无 agent_message', visibleText, raw: null, durationMs: Date.now() - started };
}

module.exports = { run };
