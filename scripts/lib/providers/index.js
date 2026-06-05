// providers/index.js — 模型执行器抽象层（路由 + 分发）
// 任务节点（task_type）→ models.yaml 路由 → 执行器（本地 CLI / 远程 API）。
// 当前生产路径：openclaw_cli。其余执行器为预留能力，enabled 后即可用（gateway 协议待定）。
//
// 执行器契约：async run({ providerCfg, model, message, sessionKey, timeoutSec, entry })
//   → { ok, error, visibleText, raw, durationMs }
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..', '..');

const IMPLS = {
  openclaw_cli: require('./openclaw_cli'),     // 生产路径
  codex_cli: require('./codex_cli'),           // 预留（实验性）
  claude_cli: require('./claude_cli'),         // 预留（实验性）
  openai_api: require('./openai_api'),         // 预留：OpenAI 兼容 HTTP
  openclaw_gateway: require('./openclaw_gateway'), // 预留：协议待定
};

// 未在 models.yaml providers: 段声明时的内置默认
const BUILTIN_PROVIDERS = {
  openclaw_cli: { type: 'cli', command: 'openclaw', enabled: true },
  codex_cli: { type: 'cli', command: 'codex', enabled: false },
  claude_cli: { type: 'cli', command: 'claude', enabled: false },
  openai_api: { type: 'openai_http', base_url: 'https://api.openai.com/v1', api_key_env: 'OPENAI_API_KEY', enabled: false },
  openclaw_gateway: { type: 'gateway', base_url: '', api_key_env: 'OPENCLAW_GATEWAY_TOKEN', enabled: false },
};

// 旧值兼容：models.yaml 历史上 provider 写作 'openclaw'
function normalizeProviderKey(k) {
  return k === 'openclaw' ? 'openclaw_cli' : k || 'openclaw_cli';
}

// ---------- models.yaml 解析 ----------
// 结构：标量段(default) / map-of-maps 段(providers) / 数组段(各 task_type)
function parseModelsYaml(text) {
  const out = { default: {}, providers: {}, tasks: {} };
  let section = null;
  let entry = null; // 数组项 或 providers 子 map
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const ind = line.length - line.trimStart().length;
    if (ind === 0 && t.endsWith(':')) {
      section = t.slice(0, -1);
      entry = null;
      if (section !== 'default' && section !== 'providers') out.tasks[section] = out.tasks[section] || [];
      continue;
    }
    if (!section) continue;
    const kv = t.match(/^([\w]+)\s*:\s*(.*)$/);
    if (section === 'default') {
      if (kv && kv[2]) out.default[kv[1]] = coerce(kv[2]);
      continue;
    }
    if (section === 'providers') {
      if (ind === 2 && kv && !kv[2]) { entry = {}; out.providers[kv[1]] = entry; continue; }
      if (ind >= 4 && entry && kv) entry[kv[1]] = coerce(kv[2]);
      continue;
    }
    // task 段：数组项
    if (t.startsWith('- ')) {
      entry = {};
      out.tasks[section].push(entry);
      const m = t.slice(2).match(/^([\w]+)\s*:\s*(.+)$/);
      if (m) entry[m[1]] = coerce(m[2]);
      continue;
    }
    if (entry && kv) entry[kv[1]] = coerce(kv[2]);
  }
  return out;
}

function coerce(v) {
  const s = String(v).trim().replace(/^["']|["']$/g, '');
  if (s === 'true') return true;
  if (s === 'false') return false;
  return s;
}

let cached = null;
function loadConfig() {
  if (cached) return cached;
  let text;
  try {
    text = require('../config_lib').getDoc('models');
  } catch (_) {
    const p = path.join(ROOT, 'config', 'models.yaml');
    text = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  }
  const parsed = parseModelsYaml(text);
  // providers 段与内置默认合并（声明覆盖内置）
  parsed.providers = { ...BUILTIN_PROVIDERS, ...Object.fromEntries(
    Object.entries(parsed.providers).map(([k, v]) => [normalizeProviderKey(k), { ...BUILTIN_PROVIDERS[normalizeProviderKey(k)], ...v }])
  ) };
  cached = parsed;
  return cached;
}

/**
 * 任务节点路由：task_type → { providerKey, providerCfg, model, entry }
 * 节点配置 = task 段第一个 enabled 项；缺省回退 default。
 */
function resolveRoute(taskType) {
  const cfg = loadConfig();
  const list = cfg.tasks[taskType];
  let entry = null;
  if (Array.isArray(list)) entry = list.find((m) => m.enabled !== false) || null;
  const providerKey = normalizeProviderKey((entry && entry.provider) || cfg.default.provider);
  const providerCfg = cfg.providers[providerKey];
  if (!providerCfg) throw new Error(`未知执行器: ${providerKey}（models.yaml providers 段未声明且无内置默认）`);
  return {
    providerKey, providerCfg,
    model: (entry && entry.model) || cfg.default.model || null,
    entry: entry || {},
  };
}

/** 统一执行入口：路由到对应执行器 */
async function runTask({ taskType, message, sessionKey, timeoutSec = 900, route = null }) {
  const r = route || resolveRoute(taskType);
  if (r.providerCfg.enabled === false) {
    return { ok: false, error: `执行器 ${r.providerKey} 未启用（models.yaml providers.${r.providerKey}.enabled: false）`, visibleText: null, raw: null, durationMs: 0 };
  }
  const impl = IMPLS[r.providerKey];
  if (!impl) {
    return { ok: false, error: `执行器 ${r.providerKey} 无实现`, visibleText: null, raw: null, durationMs: 0 };
  }
  return impl.run({ providerCfg: r.providerCfg, model: r.model, message, sessionKey, timeoutSec, entry: r.entry });
}

// 从执行器回复文本中抠出 JSON 值（数组或对象）—— 所有执行器共用
function extractJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { /* continue */ }
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch (_) { /* continue */ } }
  const arr = text.match(/\[[\s\S]*\]/);
  if (arr) { try { return JSON.parse(arr[0]); } catch (_) { /* continue */ } }
  const obj = text.match(/\{[\s\S]*\}/);
  if (obj) { try { return JSON.parse(obj[0]); } catch (_) { /* continue */ } }
  return null;
}

module.exports = { resolveRoute, runTask, extractJson, loadConfig, ROOT };
