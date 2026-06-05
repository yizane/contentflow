// sources_lib.js — sources.yaml 轻量解析（与 check_sources.js 同款缩进解析，输出更友好的结构）
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function stripQuotes(v) {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

// 解析 sources.yaml，返回 { groups: { groupName: [item, ...] } }，item 含标量字段 + group
function loadSources() {
  const raw = fs.readFileSync(path.join(ROOT, 'config', 'sources.yaml'), 'utf8');
  const lines = raw.split('\n');
  const groups = {};
  let inSources = false;
  let currentGroup = null;
  let currentItem = null;
  let itemIndent = -1;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const ind = indentOf(line);

    if (ind === 0 && /^[A-Za-z_][\w]*\s*:/.test(trimmed)) {
      inSources = trimmed.split(':')[0].trim() === 'sources';
      currentGroup = null;
      currentItem = null;
      continue;
    }
    if (!inSources) continue;

    if (ind === 2 && /^[A-Za-z_][\w]*\s*:\s*$/.test(trimmed)) {
      currentGroup = trimmed.replace(/:\s*$/, '');
      groups[currentGroup] = groups[currentGroup] || [];
      currentItem = null;
      continue;
    }
    if (!currentGroup) continue;

    if (trimmed.startsWith('- ')) {
      const m = trimmed.slice(2).match(/^([\w]+)\s*:\s*(.*)$/);
      if (m) {
        currentItem = { group: currentGroup };
        currentItem[m[1]] = stripQuotes(m[2]);
        itemIndent = ind;
        groups[currentGroup].push(currentItem);
      }
      continue;
    }
    if (currentItem && ind > itemIndent) {
      const m = trimmed.match(/^([\w]+)\s*:\s*(.*)$/);
      if (m && m[2] !== '') currentItem[m[1]] = stripQuotes(m[2]);
    }
  }
  return { groups };
}

// 扁平化所有 source items
function allSourceItems() {
  const { groups } = loadSources();
  return Object.values(groups).flat();
}

// category → sourceTrust 映射（与 sources.yaml quality_rules.source_trust 对齐）
const TRUST_BY_CATEGORY = {
  official_policy: 'primary_fact',
  official_search: 'primary_fact',
  amazon_ads: 'primary_fact',
  amazon_corporate_news: 'needs_cross_check',
  marketplace_news: 'needs_cross_check',
  retail_ecommerce_news: 'needs_cross_check',
  seo_news: 'needs_cross_check',
  ai_search_geo: 'needs_cross_check',
  seller_tool_blog: 'discovery_only',
  seller_forum: 'discovery_only',
  seller_community: 'discovery_only',
  chinese_crossborder_news: 'discovery_only',
  chinese_crossborder_report: 'discovery_only',
  amazon_rufus: 'needs_cross_check',
};

function trustOf(category) {
  return TRUST_BY_CATEGORY[category] || 'needs_cross_check';
}

module.exports = { loadSources, allSourceItems, trustOf };
