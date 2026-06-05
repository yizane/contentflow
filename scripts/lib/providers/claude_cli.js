// providers/claude_cli.js — Claude Code 本地 CLI 执行器【预留 · 实验性，未在生产验证】
// 启用：models.yaml providers.claude_cli.enabled: true；task 节点 provider: claude_cli
const { execFileSync } = require('child_process');
const logger = require('../logger_lib');

async function run({ providerCfg, model, message, timeoutSec = 900 }) {
  const command = providerCfg.command || 'claude';
  // claude -p：非交互打印模式；--output-format json 输出 { result, ... }
  const args = ['-p', message, '--output-format', 'json'];
  if (model) args.push('--model', model);
  const started = Date.now();
  logger.log(`Claude CLI 调用（实验性）: prompt ${message.length} 字符`, { name: 'claude' });
  let stdout = '';
  try {
    stdout = execFileSync(command, args, {
      encoding: 'utf8', timeout: (timeoutSec + 60) * 1000, maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    return {
      ok: false,
      error: `claude CLI 调用失败: ${(err.stderr || err.stdout || err.message || '').toString().slice(0, 600)}`,
      visibleText: null, raw: null, durationMs: Date.now() - started,
    };
  }
  let parsed = null;
  try { parsed = JSON.parse(stdout); } catch (_) { /* ignore */ }
  const visibleText = (parsed && (parsed.result || parsed.content)) || stdout.trim() || null;
  return { ok: !!visibleText, error: visibleText ? null : 'claude 输出为空', visibleText: typeof visibleText === 'string' ? visibleText : JSON.stringify(visibleText), raw: parsed, durationMs: Date.now() - started };
}

module.exports = { run };
