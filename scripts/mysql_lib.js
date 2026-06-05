// mysql_lib.js — MySQL 连接层（唯一运行时数据源；不 fallback SQLite）
require('dotenv').config();
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function configFromEnv() {
  const required = ['MYSQL_HOST', 'MYSQL_DATABASE', 'MYSQL_USER', 'MYSQL_PASSWORD'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(JSON.stringify({
      ok: false,
      error: `MySQL 未配置（缺环境变量: ${missing.join(', ')}）。请 cp .env.example .env 并填写 MySQL 连接信息。本项目不 fallback SQLite。`,
    }, null, 2));
    process.exit(1);
  }
  return {
    host: process.env.MYSQL_HOST,
    port: parseInt(process.env.MYSQL_PORT || '3306', 10),
    database: process.env.MYSQL_DATABASE,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    ssl: process.env.MYSQL_SSL === 'true' ? {} : undefined,
    connectionLimit: parseInt(process.env.MYSQL_CONNECTION_LIMIT || '5', 10),
    multipleStatements: true,
    charset: 'utf8mb4',
  };
}

let pool = null;

function getPool() {
  if (!pool) pool = mysql.createPool(configFromEnv());
  return pool;
}

async function query(sql, params = []) {
  const [rows] = await getPool().execute(sql, params);
  return rows;
}

// 多语句执行（schema 初始化用）
async function exec(sql) {
  const conn = await getPool().getConnection();
  try {
    await conn.query(sql);
  } finally {
    conn.release();
  }
}

// 便捷 insert：insert('table', {col: val, ...})；JSON 值自动序列化
async function insert(table, data) {
  const cols = Object.keys(data);
  const vals = cols.map((c) => {
    const v = data[c];
    if (v === undefined) return null;
    if (v !== null && typeof v === 'object') return JSON.stringify(v);
    return v;
  });
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  await query(sql, vals);
}

async function update(table, data, whereSql, whereParams = []) {
  const cols = Object.keys(data);
  const vals = cols.map((c) => {
    const v = data[c];
    if (v === undefined) return null;
    if (v !== null && typeof v === 'object') return JSON.stringify(v);
    return v;
  });
  await query(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE ${whereSql}`, [...vals, ...whereParams]);
}

// JSON 列读取兜底（mysql2 通常自动解析 JSON 列，这里兜底字符串场景）
function asJson(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return v;
  try {
    return JSON.parse(v);
  } catch (_) {
    return null;
  }
}

// DATETIME(3) 值（MySQL 不收 ISO 的 'T'/'Z'）
function now() {
  return new Date().toISOString().slice(0, 23).replace('T', ' ');
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function makeRunId(prefix = 'run') {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${prefix}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}_${crypto.randomBytes(2).toString('hex')}`;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text || '').digest('hex');
}

// 按 id / slug / status 选文章
async function findArticles({ articleId = null, slug = null, status = null, limit = 10 } = {}) {
  const lim = Math.max(1, Math.min(200, parseInt(limit, 10) || 10));
  if (articleId) return query('SELECT * FROM articles WHERE id = ?', [articleId]);
  if (slug) return query(`SELECT * FROM articles WHERE slug = ? ORDER BY created_at DESC LIMIT ${lim}`, [slug]);
  if (status) return query(`SELECT * FROM articles WHERE status = ? ORDER BY created_at DESC LIMIT ${lim}`, [status]);
  return [];
}

// 文章最新版本
async function latestVersion(articleId) {
  const rows = await query('SELECT * FROM article_versions WHERE article_id = ? ORDER BY created_at DESC LIMIT 1', [articleId]);
  return rows[0] || null;
}

// model_runs 记录
async function recordModelRun(fields) {
  await insert('model_runs', {
    id: makeId('mrun'),
    engine_run_id: fields.engineRunId || null,
    article_id: fields.articleId || null,
    article_version_id: fields.articleVersionId || null,
    task_type: fields.taskType,
    model_provider: fields.provider || null,
    model_name: fields.model || null,
    openclaw_session_key: fields.sessionKey || null,
    task_prompt: fields.taskPrompt || null,
    raw_response: fields.rawResponse || null,
    parsed_output_json: fields.parsedOutput || null,
    status: fields.status,
    started_at: fields.startedAt,
    finished_at: now(),
    error_message: fields.error || null,
    raw_summary_json: fields.rawSummary || null,
  });
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { ROOT, getPool, query, exec, insert, update, asJson, now, makeId, makeRunId, sha256, findArticles, latestVersion, recordModelRun, closePool, configFromEnv };
