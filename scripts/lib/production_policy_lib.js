// production_policy_lib.js — 生产策略加载 + 去重工具（Jaccard 相似度，无 embedding）
const config = require('./config_lib');

const DEFAULTS = {
  dedupe: {
    normalized_topic_window_days: 30,
    slug_window_days: 90,
    primary_keyword_window_days: 14,
    max_articles_per_primary_keyword_in_window: 2,
    // 主题簇/业务分类级节流：防止换关键词、换说法但同主题的文章连续产出（Phase 12 分类体系支撑）
    topic_cluster_window_days: 14,
    max_articles_per_topic_cluster_in_window: 1,
    business_category_window_days: 7,
    max_articles_per_business_category_in_window: 3,
  },
  topic_generation: {
    reject_if_similar_topic_recent: true,
    reject_if_slug_exists: true,
    prefer_new_keyword_clusters: true,
  },
  batch_limits: { default_limit: 1, max_limit_without_force: 5 },
  review: { require_channels_for_package: false, required_channels: ['wechat', 'douyin', 'xiaohongshu'] },
};

function loadPolicy() {
  const policy = JSON.parse(JSON.stringify(DEFAULTS));
  let text;
  try { text = config.getDoc('production_policy'); } catch (_) { return DEFAULTS; }
  const lines = text.split('\n');
  let section = null;
  let listKey = null;
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const ind = line.length - line.trimStart().length;
    if (ind === 0 && t.endsWith(':')) {
      section = t.slice(0, -1);
      listKey = null;
      continue;
    }
    if (!section || !policy[section]) continue;
    if (t.endsWith(':') && ind === 2) {
      listKey = t.slice(0, -1);
      policy[section][listKey] = [];
      continue;
    }
    if (t.startsWith('- ') && listKey) {
      policy[section][listKey].push(t.slice(2).trim());
      continue;
    }
    const m = t.match(/^([\w]+)\s*:\s*(.+)$/);
    if (m) {
      const v = m[2].trim();
      policy[section][m[1]] = v === 'true' ? true : v === 'false' ? false : /^\d+$/.test(v) ? parseInt(v, 10) : v;
      listKey = null;
    }
  }
  return policy;
}

// 中英混合分词：连续英数字为一个 token，汉字按 2-gram
function tokenize(text) {
  const tokens = new Set();
  const norm = (text || '').toLowerCase().replace(/[^一-龥a-z0-9]+/g, ' ');
  for (const part of norm.split(/\s+/)) {
    if (!part) continue;
    if (/^[a-z0-9]+$/.test(part)) {
      tokens.add(part);
    } else {
      // 汉字段 2-gram
      const han = part.replace(/[a-z0-9]/g, '');
      for (let i = 0; i < han.length - 1; i++) tokens.add(han.slice(i, i + 2));
      const latin = part.replace(/[一-龥]/g, '');
      if (latin) tokens.add(latin);
    }
  }
  return tokens;
}

function jaccard(a, b) {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

const SIMILARITY_THRESHOLD = 0.55;

/**
 * 候选主题去重检查。
 * @returns {null | {reason: string}} null = 通过
 */
function dedupeCheck(db, candidate, policy) {
  const d = policy.dedupe;
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

  // 1) 近 N 天相似主题（对比 articles.title + topic_candidates.topic 非 rejected）
  if (policy.topic_generation.reject_if_similar_topic_recent) {
    const recentTopics = [
      ...db.prepare('SELECT title AS t FROM articles WHERE created_at >= ?').all(daysAgo(d.normalized_topic_window_days)).map((r) => r.t),
      ...db.prepare("SELECT topic AS t FROM topic_candidates WHERE created_at >= ? AND status != 'rejected'").all(daysAgo(d.normalized_topic_window_days)).map((r) => r.t),
    ];
    for (const t of recentTopics) {
      const sim = jaccard(candidate.topic, t);
      if (sim >= SIMILARITY_THRESHOLD) {
        return { reason: `近 ${d.normalized_topic_window_days} 天存在高相似主题（Jaccard ${sim.toFixed(2)}）: "${t.slice(0, 40)}"` };
      }
    }
  }

  // 2) primary_keyword 节流：近 N 天同主关键词文章数
  const kwCount = db
    .prepare('SELECT COUNT(*) c FROM articles WHERE primary_keyword = ? AND created_at >= ?')
    .get(candidate.primaryKeyword, daysAgo(d.primary_keyword_window_days)).c;
  if (kwCount >= d.max_articles_per_primary_keyword_in_window) {
    return { reason: `primary_keyword "${candidate.primaryKeyword}" 近 ${d.primary_keyword_window_days} 天已有 ${kwCount} 篇（上限 ${d.max_articles_per_primary_keyword_in_window}）` };
  }

  return null;
}

module.exports = { loadPolicy, jaccard, tokenize, dedupeCheck, SIMILARITY_THRESHOLD };
