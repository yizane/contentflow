// config_lib.js — 配置统一来源：MySQL 优先（Web 可管理），仓库文件为 seed/fallback
// 用法：await ensureInit() 一次（pipeline 入口自动调用），之后各 getter 同步读缓存。
const fs = require('fs');
const path = require('path');
const my = require('./mysql_lib');

const ROOT = path.resolve(__dirname, '..', '..');

const cache = {
  inited: false,
  keywords: [],        // config_keywords rows（enabled）
  sources: [],         // config_sources rows（enabled）→ 旧 allSourceItems 形状
  docs: {},            // app_configs: key → content
  fallbacks: [],       // 走了文件回退的 key（提示运行 config:sync）
};

function fileFallback(rel) {
  const abs = path.join(ROOT, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
}

async function ensureInit() {
  if (cache.inited) return cache;

  // 1) 文档配置
  try {
    const rows = await my.query('SELECT config_key, content FROM app_configs');
    for (const r of rows) cache.docs[r.config_key] = r.content;
  } catch (_) { /* 表不存在等：全走文件回退 */ }

  const wantDocs = [
    ['internal_claims', 'config/internal_claims.yaml'],
    ['production_policy', 'config/production_policy.yaml'],
    ['models', 'config/models.yaml'],
    ['sources_yaml', 'config/sources.yaml'],
    ['content_taxonomy', 'config/content_taxonomy.yaml'],
    ['content_portfolio', 'config/content_portfolio.yaml'],
  ];
  for (const f of fs.existsSync(path.join(ROOT, 'prompts')) ? fs.readdirSync(path.join(ROOT, 'prompts')) : []) {
    if (f.endsWith('.md')) wantDocs.push([`prompt:${f}`, `prompts/${f}`]);
  }
  for (const f of fs.existsSync(path.join(ROOT, 'schemas')) ? fs.readdirSync(path.join(ROOT, 'schemas')) : []) {
    if (f.endsWith('.json')) wantDocs.push([`schema:${f}`, `schemas/${f}`]);
  }
  for (const [key, rel] of wantDocs) {
    if (!cache.docs[key]) {
      const content = fileFallback(rel);
      if (content !== null) {
        cache.docs[key] = content;
        cache.fallbacks.push(key);
      }
    }
  }

  // 2) 关键词
  try {
    cache.keywords = await my.query('SELECT keyword, cluster, intent, priority, stage, business_angle FROM config_keywords WHERE enabled = 1 ORDER BY priority, keyword');
  } catch (_) { /* ignore */ }
  if (cache.keywords.length === 0) {
    const csv = cache.docs['keywords_csv'] || fileFallback('config/keywords.csv');
    if (csv) {
      const lines = csv.trim().split('\n').slice(1);
      cache.keywords = lines.map((l) => {
        const [keyword, cluster, intent, priority, stage, business_angle] = l.split(',').map((x) => (x || '').trim());
        return { keyword, cluster, intent, priority, stage, business_angle };
      });
      cache.fallbacks.push('config_keywords');
    }
  }

  // 3) 采集源（映射为旧 allSourceItems 形状：group/name/type/.../requires_auth 为 'true'/'false' 字符串）
  try {
    const rows = await my.query('SELECT * FROM config_sources WHERE enabled = 1');
    cache.sources = rows.map((r) => ({
      group: r.group_name, name: r.name, type: r.type, category: r.category, priority: r.priority,
      url: r.url || undefined, site_url: r.site_url || undefined, language: r.language || undefined,
      requires_auth: r.requires_auth ? 'true' : 'false', freshness: r.freshness || undefined,
      query: r.query_text || undefined, notes: r.notes || undefined,
    }));
  } catch (_) { /* ignore */ }
  if (cache.sources.length === 0) {
    // 文件回退：用 sources_lib 的 YAML 解析
    const { allSourceItems } = require('./sources_lib');
    try {
      cache.sources = allSourceItems();
      cache.fallbacks.push('config_sources');
    } catch (_) { /* ignore */ }
  }

  if (cache.fallbacks.length) {
    console.warn(`[config] ${cache.fallbacks.length} 项配置未入库，使用仓库文件回退（建议运行 npm run config:sync）: ${cache.fallbacks.slice(0, 5).join(', ')}${cache.fallbacks.length > 5 ? '…' : ''}`);
  }
  cache.inited = true;
  return cache;
}

function assertInited() {
  if (!cache.inited) throw new Error('config_lib 未初始化：先 await ensureInit()');
}

function getDoc(key) {
  assertInited();
  const c = cache.docs[key];
  if (c === undefined) throw new Error(`配置缺失: ${key}（DB 与文件均无，运行 npm run config:sync 或检查仓库）`);
  return c;
}

function getKeywords() {
  assertInited();
  return cache.keywords;
}

// 旧 keywords.csv 文本形状（prompt 注入用）
function getKeywordsCsv() {
  assertInited();
  const header = 'keyword,cluster,intent,priority,stage,business_angle';
  return [header, ...cache.keywords.map((k) => [k.keyword, k.cluster, k.intent, k.priority, k.stage, k.business_angle].join(','))].join('\n');
}

function getKeywordSet() {
  assertInited();
  return new Set(cache.keywords.map((k) => k.keyword));
}

function getSourceItems() {
  assertInited();
  return cache.sources;
}

function getFallbacks() {
  return cache.fallbacks;
}

module.exports = { ensureInit, getDoc, getKeywords, getKeywordsCsv, getKeywordSet, getSourceItems, getFallbacks };
