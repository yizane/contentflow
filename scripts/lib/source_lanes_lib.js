// source_lanes_lib.js — source lane and source enablement rules.

const LANE_RANK = { knowledge: 1, news: 2, policy: 3 };

function boolValue(v, defaultValue = true) {
  if (v === undefined || v === null || v === '') return defaultValue;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).trim().toLowerCase();
  if (['false', '0', 'no', 'off', 'disabled'].includes(s)) return false;
  if (['true', '1', 'yes', 'on', 'enabled'].includes(s)) return true;
  return defaultValue;
}

function parseExtraJson(v) {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return {}; }
}

function isSourceEnabled(source) {
  return boolValue(source.enabled, true);
}

function shouldRunDailyQuery(source) {
  if (source.type !== 'search_query') return true;
  return boolValue(source.daily_query_enabled, true);
}

function laneFromFreshness(freshness) {
  if (freshness === 'breaking_news') return 'news';
  if (freshness === 'policy_update') return 'policy';
  if (freshness === 'evergreen_blog') return 'knowledge';
  return 'knowledge';
}

function resolveSourceLane(source = {}) {
  if (source.lane && LANE_RANK[source.lane]) return source.lane;
  const name = String(source.name || source.sourceName || '').toLowerCase();
  const category = source.category || source.sourceCategory;

  if (name.includes('resources library') || name.includes('search engine journal') || name.includes('google ai blog') || name.includes('perplexity')) {
    return 'knowledge';
  }
  if (category === 'seller_tool_blog' || category === 'chinese_crossborder_report') return 'knowledge';
  if (category === 'official_policy' || category === 'official_search' || name.includes('seller central news') || name.includes('seller forums')) return 'policy';
  if (category === 'amazon_ads' && source.freshness === 'policy_update' && !name.includes('resources library')) return 'policy';

  return laneFromFreshness(source.freshness);
}

function strongerLane(a, b) {
  const la = LANE_RANK[a] ? a : 'knowledge';
  const lb = LANE_RANK[b] ? b : 'knowledge';
  return LANE_RANK[lb] > LANE_RANK[la] ? lb : la;
}

function sourcePriorityScore(source = {}) {
  const p = String(source.priority || '').toLowerCase();
  if (p === 'high' || p === 'p0') return 30;
  if (p === 'medium' || p === 'p1') return 20;
  if (p === 'low' || p === 'p2') return 10;
  return 15;
}

module.exports = {
  LANE_RANK,
  boolValue,
  parseExtraJson,
  isSourceEnabled,
  shouldRunDailyQuery,
  laneFromFreshness,
  resolveSourceLane,
  strongerLane,
  sourcePriorityScore,
};
