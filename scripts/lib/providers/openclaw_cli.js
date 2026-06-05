// providers/openclaw_cli.js — OpenClaw 本地 CLI 执行器（生产路径）
const { execFileSync } = require('child_process');
const logger = require('../logger_lib');

async function run({ providerCfg, model, message, sessionKey, timeoutSec = 900 }) {
  const command = providerCfg.command || 'openclaw';
  const args = ['agent', '--session-key', sessionKey, '--message', message, '--timeout', String(timeoutSec), '--json'];
  if (model) args.push('--model', model);
  const started = Date.now();
  logger.log(`OpenClaw 调用: ${sessionKey}（prompt ${message.length} 字符, timeout ${timeoutSec}s）`, { name: 'openclaw' });
  let stdout = '';
  try {
    stdout = execFileSync(command, args, {
      encoding: 'utf8',
      timeout: (timeoutSec + 60) * 1000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    logger.logError(`OpenClaw 失败: ${sessionKey}: ${(err.stderr || err.stdout || err.message || '').toString().slice(0, 800)}`, { name: 'openclaw' });
    return {
      ok: false,
      error: `openclaw CLI 调用失败: ${(err.stderr || err.stdout || err.message || '').toString().slice(0, 600)}`,
      visibleText: null, raw: null, durationMs: Date.now() - started,
    };
  }

  // 解析 --json 输出（容错：取最后一个 JSON 对象）
  let parsed = null;
  try {
    parsed = JSON.parse(stdout);
  } catch (_) {
    const m = stdout.match(/\{[\s\S]*\}\s*$/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch (_) { /* ignore */ } }
  }

  let visibleText = null;
  if (parsed) {
    const r = parsed.result || parsed;
    visibleText =
      (r.response && (r.response.finalAssistantVisibleText || r.response.finalAssistantRawText)) ||
      (Array.isArray(r.payloads) && r.payloads[0] && r.payloads[0].text) ||
      null;
  }
  logger.log(`OpenClaw 完成: ${sessionKey}（${Date.now() - started}ms, 回复 ${(visibleText || '').length} 字符）`, { name: 'openclaw' });
  return { ok: true, error: null, visibleText, raw: parsed, durationMs: Date.now() - started };
}

module.exports = { run };
