// openclaw_lib.js — OpenClaw agent CLI 调用封装（所有自动执行任务统一走这里）
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// 读取 config/models.yaml（轻量解析，结构固定）
function loadModels() {
  const result = { default: { provider: 'openclaw', model: null, thinking: 'off' } };
  let text;
  try {
    text = require('./config_lib').getDoc('models');
  } catch (_) {
    const p = path.join(ROOT, 'config', 'models.yaml');
    if (!fs.existsSync(p)) return result;
    text = fs.readFileSync(p, 'utf8');
  }
  const lines = text.split('\n');
  let section = null;
  let entry = null;
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const ind = line.length - line.trimStart().length;
    if (ind === 0 && t.endsWith(':')) {
      section = t.slice(0, -1);
      if (section !== 'default') result[section] = [];
      entry = null;
      continue;
    }
    if (!section) continue;
    if (section === 'default') {
      const m = t.match(/^([\w]+)\s*:\s*(.+)$/);
      if (m) result.default[m[1]] = m[2].trim();
      continue;
    }
    if (t.startsWith('- ')) {
      entry = {};
      result[section].push(entry);
      const m = t.slice(2).match(/^([\w]+)\s*:\s*(.+)$/);
      if (m) entry[m[1]] = m[2].trim();
      continue;
    }
    if (entry) {
      const m = t.match(/^([\w]+)\s*:\s*(.+)$/);
      if (m) entry[m[1]] = m[2] === 'true' ? true : m[2] === 'false' ? false : m[2].trim();
    }
  }
  return result;
}

// 取某个 task_type 的首个 enabled 模型（多模型并行为 P2 TODO）
function modelFor(taskType) {
  const models = loadModels();
  const list = models[taskType];
  if (Array.isArray(list)) {
    const enabled = list.find((m) => m.enabled !== false);
    if (enabled) return { provider: enabled.provider || 'openclaw', model: enabled.model || models.default.model };
  }
  return { provider: models.default.provider || 'openclaw', model: models.default.model };
}

/**
 * 调用 OpenClaw agent 执行一段任务消息。
 * @returns {{ok: boolean, error: string|null, visibleText: string|null, raw: object|null, durationMs: number}}
 */
function runAgentTask({ sessionKey, message, timeoutSec = 900, model = null }) {
  const args = ['agent', '--session-key', sessionKey, '--message', message, '--timeout', String(timeoutSec), '--json'];
  if (model) args.push('--model', model);
  const started = Date.now();
  let stdout = '';
  try {
    stdout = execFileSync('openclaw', args, {
      encoding: 'utf8',
      timeout: (timeoutSec + 60) * 1000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    return {
      ok: false,
      error: `openclaw CLI 调用失败: ${(err.stderr || err.stdout || err.message || '').toString().slice(0, 600)}`,
      visibleText: null,
      raw: null,
      durationMs: Date.now() - started,
    };
  }

  // 解析 --json 输出（容错：取最后一个 JSON 对象）
  let parsed = null;
  try {
    parsed = JSON.parse(stdout);
  } catch (_) {
    const m = stdout.match(/\{[\s\S]*\}\s*$/);
    if (m) {
      try {
        parsed = JSON.parse(m[0]);
      } catch (_) {
        /* ignore */
      }
    }
  }

  let visibleText = null;
  if (parsed) {
    const r = parsed.result || parsed;
    visibleText =
      (r.response && (r.response.finalAssistantVisibleText || r.response.finalAssistantRawText)) ||
      (Array.isArray(r.payloads) && r.payloads[0] && r.payloads[0].text) ||
      null;
  }
  return { ok: true, error: null, visibleText, raw: parsed, durationMs: Date.now() - started };
}

// 从 agent 回复文本中尽量抠出一个 JSON 值（数组或对象）
function extractJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    /* continue */
  }
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try {
      return JSON.parse(fence[1]);
    } catch (_) {
      /* continue */
    }
  }
  const arr = text.match(/\[[\s\S]*\]/);
  if (arr) {
    try {
      return JSON.parse(arr[0]);
    } catch (_) {
      /* continue */
    }
  }
  const obj = text.match(/\{[\s\S]*\}/);
  if (obj) {
    try {
      return JSON.parse(obj[0]);
    } catch (_) {
      /* continue */
    }
  }
  return null;
}

module.exports = { runAgentTask, extractJson, loadModels, modelFor, ROOT };
