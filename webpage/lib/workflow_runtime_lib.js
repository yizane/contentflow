// workflow_runtime_lib.js — Viewer-side time helpers only.

function normalizeEngineNow(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const isoLike = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00.000Z` : raw.includes('T') ? raw : raw.replace(' ', 'T');
  const d = new Date(isoLike);
  if (Number.isNaN(d.getTime())) throw new Error(`ENGINE_NOW 非法: ${value}`);
  return d.toISOString().slice(0, 23) + 'Z';
}

function engineNowDate(value = process.env.ENGINE_NOW) {
  const normalized = normalizeEngineNow(value);
  return normalized ? new Date(normalized) : new Date();
}

function mysqlDateTimeFromDate(date) {
  return date.toISOString().slice(0, 23).replace('T', ' ');
}

function mysqlDateTime(value = process.env.ENGINE_NOW) {
  return mysqlDateTimeFromDate(engineNowDate(value));
}

function dailyKeyFromDate(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

module.exports = { normalizeEngineNow, engineNowDate, mysqlDateTime, mysqlDateTimeFromDate, dailyKeyFromDate };
