// providers/openai_api.js — OpenAI 兼容 HTTP 执行器【预留，默认 disabled】
// 适用于任何 /chat/completions 兼容服务（OpenAI / DeepSeek / 本地 vLLM / Ollama 等）。
// 启用：models.yaml providers.openai_api: { enabled: true, base_url, api_key_env }；task 节点 provider: openai_api
const logger = require('../logger_lib');

async function run({ providerCfg, model, message, timeoutSec = 900 }) {
  const baseUrl = (providerCfg.base_url || '').replace(/\/$/, '');
  if (!baseUrl) return { ok: false, error: 'openai_api 未配置 base_url', visibleText: null, raw: null, durationMs: 0 };
  const apiKey = providerCfg.api_key_env ? process.env[providerCfg.api_key_env] : null;
  const started = Date.now();
  logger.log(`OpenAI 兼容 API 调用: ${baseUrl}（model ${model || providerCfg.model || '-'}）`, { name: 'openai_api' });
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutSec * 1000);
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: model || providerCfg.model,
        messages: [{ role: 'user', content: message }],
      }),
    });
    clearTimeout(timer);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `openai_api HTTP ${res.status}: ${body.slice(0, 400)}`, visibleText: null, raw: null, durationMs: Date.now() - started };
    }
    const data = await res.json();
    const visibleText = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || null;
    return { ok: !!visibleText, error: visibleText ? null : 'openai_api 回复无内容', visibleText, raw: data, durationMs: Date.now() - started };
  } catch (err) {
    return { ok: false, error: `openai_api 调用失败: ${err.message.slice(0, 400)}`, visibleText: null, raw: null, durationMs: Date.now() - started };
  }
}

module.exports = { run };
