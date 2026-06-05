// logger_lib.js — 本地调试日志（logs/ 目录，gitignored）
// 定位：排查问题用的 debug 产物，不是 runtime 状态（状态仍以 MySQL 为准）。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const LOG_DIR = path.join(ROOT, 'logs');

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function logFile(name = 'engine') {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return path.join(LOG_DIR, `${name}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.log`);
}

/**
 * 追加一行日志。写失败静默（日志不能影响主流程）。
 * @param {string} line
 * @param {object} opts { name: 日志文件前缀（engine/viewer/openclaw）, level: INFO/WARN/ERROR }
 */
function log(line, { name = 'engine', level = 'INFO' } = {}) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(logFile(name), `[${ts()}] [${level}] ${String(line).replace(/\n/g, '\n    ')}\n`);
  } catch (_) { /* 日志失败不影响主流程 */ }
}

function logError(line, opts = {}) {
  log(line, { ...opts, level: 'ERROR' });
}
function logWarn(line, opts = {}) {
  log(line, { ...opts, level: 'WARN' });
}

module.exports = { log, logWarn, logError, LOG_DIR };
