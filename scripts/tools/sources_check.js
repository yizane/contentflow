#!/usr/bin/env node
// sources_check.js — 校验 config/sources.yaml 结构
// 说明：项目零依赖（无 YAML 解析库），这里做针对本文件结构的轻量缩进解析。
// 如果将来引入 js-yaml 等依赖，可替换 parseSourcesYaml() 为真实 YAML 解析。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const YAML_PATH = path.join(ROOT, 'config', 'sources.yaml');

const VALID_TYPES = ['rss', 'atom', 'fetch_page', 'discover_feed_or_fetch', 'search_query'];
const URL_TYPES = ['rss', 'atom', 'fetch_page', 'discover_feed_or_fetch'];
const REQUIRED_ITEM_FIELDS = ['name', 'type', 'category', 'priority'];
const VALID_FALLBACK_TYPES = ['fetch_page', 'discover_feed_or_fetch', 'search_query'];
const VALID_LANGUAGES = ['en', 'zh-CN'];
const CHINESE_CATEGORIES = ['chinese_crossborder_news', 'chinese_crossborder_report'];
// 允许的可选元数据字段（feed 验证流程产生）：feed_verified_at / feed_discovered_by / fallback_type / site_url / language

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function stripQuotes(v) {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

// 解析 sources.yaml：提取顶级 key 集合 + sources 下的分组与 item 的标量字段
function parseSourcesYaml(raw) {
  const lines = raw.split('\n');
  const topLevelKeys = new Set();
  const groups = {}; // groupName -> [{ fields: {...}, line: N }]

  let inSources = false;
  let currentGroup = null;
  let currentItem = null;
  let itemIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const ind = indentOf(line);

    // 顶级 key（无缩进，形如 "key:" 或 "key: value"）
    if (ind === 0 && /^[A-Za-z_][\w]*\s*:/.test(trimmed)) {
      const key = trimmed.split(':')[0].trim();
      topLevelKeys.add(key);
      inSources = key === 'sources';
      currentGroup = null;
      currentItem = null;
      continue;
    }

    if (!inSources) continue;

    // 分组（缩进 2，形如 "group_name:"）
    if (ind === 2 && /^[A-Za-z_][\w]*\s*:\s*$/.test(trimmed)) {
      currentGroup = trimmed.replace(/:\s*$/, '');
      groups[currentGroup] = groups[currentGroup] || [];
      currentItem = null;
      continue;
    }

    if (!currentGroup) continue;

    // item 起始（"- name: xxx" 或 "- xxx:" 列表项）
    if (trimmed.startsWith('- ')) {
      const rest = trimmed.slice(2);
      const m = rest.match(/^([\w]+)\s*:\s*(.*)$/);
      if (m) {
        // 新 item（以 "- name:" 开头视为 item；其他 "- key:" 也兼容）
        currentItem = { fields: {}, line: i + 1 };
        currentItem.fields[m[1]] = stripQuotes(m[2]);
        itemIndent = ind;
        groups[currentGroup].push(currentItem);
      }
      // "- 纯字符串"（use_case 列表项等）忽略
      continue;
    }

    // item 字段（缩进比 item 起始深，形如 "key: value"）
    if (currentItem && ind > itemIndent) {
      const m = trimmed.match(/^([\w]+)\s*:\s*(.*)$/);
      if (m && m[2] !== '') {
        currentItem.fields[m[1]] = stripQuotes(m[2]);
      }
      // "key:"（嵌套列表头，如 use_case:）忽略——只校验标量字段
    }
  }

  return { topLevelKeys, groups };
}

function main() {
  const errors = [];
  const warnings = [];
  const info = [];

  if (!fs.existsSync(YAML_PATH)) {
    console.log(JSON.stringify({ ok: false, errors: ['config/sources.yaml 不存在'], warnings: [], summary: {} }, null, 2));
    process.exit(1);
  }

  const raw = fs.readFileSync(YAML_PATH, 'utf8');
  const { topLevelKeys, groups } = parseSourcesYaml(raw);

  // --- 顶级结构校验 ---
  for (const key of ['version', 'sources', 'source_policy', 'topic_filters', 'quality_rules']) {
    if (!topLevelKeys.has(key)) errors.push(`缺少顶级字段: ${key}`);
  }

  // --- item 校验 ---
  let items = 0;
  let rssLike = 0;
  let fetchPages = 0;
  let searchQueries = 0;
  const seenUrls = new Map();
  const seenNames = new Map();

  for (const [group, list] of Object.entries(groups)) {
    if (list.length === 0) {
      warnings.push(`分组 ${group} 没有任何 item`);
      continue;
    }
    for (const item of list) {
      items++;
      const f = item.fields;
      const label = f.name ? `"${f.name}"` : `(${group} 第 ${item.line} 行)`;

      // 必填字段
      for (const field of REQUIRED_ITEM_FIELDS) {
        if (!f[field]) errors.push(`${group} ${label} 缺少字段: ${field}`);
      }

      // type 合法性
      if (f.type && !VALID_TYPES.includes(f.type)) {
        errors.push(`${group} ${label} type 非法: "${f.type}"（允许: ${VALID_TYPES.join(', ')}）`);
      }

      // type 对应的必填项
      if (URL_TYPES.includes(f.type)) {
        if (!f.url) {
          errors.push(`${group} ${label} type=${f.type} 但缺少 url`);
        } else if (!/^https?:\/\//.test(f.url)) {
          errors.push(`${group} ${label} url 不是合法 http(s) 链接: ${f.url}`);
        }
        if (f.type === 'rss' || f.type === 'atom') rssLike++;
        else fetchPages++;
      }
      if (f.type === 'search_query') {
        searchQueries++;
        if (!f.query) errors.push(`${group} ${label} type=search_query 但缺少 query`);
        if (f.url) warnings.push(`${group} ${label} type=search_query 不应有 url 字段`);
      }

      // rss/atom 同时带 site_url：正常（fallback 用），给 info 不报错
      if ((f.type === 'rss' || f.type === 'atom') && f.site_url) {
        if (f.feed_verified_at) {
          info.push(`${group} ${label} feed 已本地验证（${f.type}, ${f.feed_verified_at}），site_url 作为 fallback 抓取页面`);
        } else {
          info.push(`${group} ${label} 声明为 ${f.type}（未经本地验证），site_url 作为 fallback 抓取页面`);
        }
      }

      // fallback_type 合法性
      if (f.fallback_type && !VALID_FALLBACK_TYPES.includes(f.fallback_type)) {
        errors.push(`${group} ${label} fallback_type 非法: "${f.fallback_type}"（允许: ${VALID_FALLBACK_TYPES.join(', ')}）`);
      }

      // language 字段校验
      if (f.language && !VALID_LANGUAGES.includes(f.language)) {
        warnings.push(`${group} ${label} language 值非常规: "${f.language}"（建议: ${VALID_LANGUAGES.join(', ')}）`);
      }
      if (CHINESE_CATEGORIES.includes(f.category) && f.language !== 'zh-CN') {
        warnings.push(`${group} ${label} category=${f.category} 建议设置 language: zh-CN`);
      }

      // feed 验证元数据的一致性提醒
      if (f.feed_verified_at && !/^\d{4}-\d{2}-\d{2}$/.test(f.feed_verified_at)) {
        warnings.push(`${group} ${label} feed_verified_at 不是 YYYY-MM-DD 格式: ${f.feed_verified_at}`);
      }
      if (f.feed_verified_at && !(f.type === 'rss' || f.type === 'atom')) {
        warnings.push(`${group} ${label} 有 feed_verified_at 但 type 不是 rss/atom`);
      }
      if ((f.type === 'rss' || f.type === 'atom') && f.fallback_type && !f.site_url) {
        warnings.push(`${group} ${label} 声明了 fallback_type 但缺少 site_url，fallback 无目标页面`);
      }

      // 软性提醒
      if (!f.freshness) warnings.push(`${group} ${label} 建议补充 freshness 字段`);
      if (f.requires_auth === 'true') warnings.push(`${group} ${label} requires_auth=true，抓取时需要登录态，自动化采集可能拿不到内容`);

      // 去重检查
      if (f.url) {
        if (seenUrls.has(f.url)) warnings.push(`重复 url: ${f.url}（${seenUrls.get(f.url)} 与 ${group}）`);
        else seenUrls.set(f.url, group);
      }
      if (f.name) {
        if (seenNames.has(f.name)) errors.push(`重复 name: "${f.name}"（${seenNames.get(f.name)} 与 ${group}）`);
        else seenNames.set(f.name, group);
      }
    }
  }

  if (items === 0) errors.push('sources 下没有解析到任何 item');

  const result = {
    ok: errors.length === 0,
    warnings,
    errors,
    info,
    summary: {
      groups: Object.keys(groups).length,
      items,
      rssLike,
      fetchPages,
      searchQueries,
    },
  };

  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

main();
