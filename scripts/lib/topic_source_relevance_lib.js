// topic_source_relevance_lib.js — 主题候选的来源行业相关性守门
// 目标：高分候选必须由「亚马逊电商行业」素材直接支撑；其他电商/泛行业来源暂时压低并排除。

const AMAZON_HOST_RE = /(^|\.)((aboutamazon|sellercentral|sell|advertising|developer|business)\.amazon\.com|amazon\.[a-z.]+)$/i;
const AMAZON_ECOMMERCE_RE = /\bamazon\b|亚马逊|seller\s*central|vendor\s*central|amazon\s*(seller|ads?|advertising|marketplace)|fba\b|fbm\b|asin\b|buy\s*box|prime\s*day|sponsored\s*(products?|brands?|display)|卖家平台|卖家中心|亚马逊(美国站|卖家|广告|平台|店铺|站内)|购物车按钮/i;
const NON_AMAZON_ECOMMERCE_RE = /电商|跨境|marketplace|e-?commerce|retail\s*media|零售媒体|wildberries|ozon|yandex\s*market|magnit|shopee|lazada|temu|shein|tiktok\s*shop|walmart|ebay|shopify|速卖通|阿里国际站/i;

function canonicalUrl(url) {
  return String(url || '').trim().replace(/\/$/, '');
}

function candidateSourceUrls(candidate) {
  const urls = candidate.sourceUrls || candidate.source_urls_json || [];
  if (typeof urls === 'string') {
    try { return JSON.parse(urls).map(canonicalUrl).filter(Boolean); } catch (_) { return []; }
  }
  return Array.isArray(urls) ? urls.map(canonicalUrl).filter(Boolean) : [];
}

function lookupSource(sourceByUrl, url) {
  if (!sourceByUrl || !url) return null;
  return sourceByUrl.get(url) || sourceByUrl.get(canonicalUrl(url)) || sourceByUrl.get(`${canonicalUrl(url)}/`) || null;
}

function sourceText(source) {
  return [
    source && source.source_group,
    source && source.source_name,
    source && source.source_url,
    source && source.title,
    source && source.summary,
  ].filter(Boolean).join('\n');
}

function assessSource(source) {
  if (!source) {
    return { isAmazonEcommerce: false, isNonAmazonEcommerce: false, reason: 'source_url 未匹配到 source_items' };
  }
  const url = source.source_url || source.url || '';
  let host = '';
  try { host = new URL(url).hostname; } catch (_) {}
  const text = sourceText(source);
  const isAmazonEcommerce = source.source_group === 'official_amazon'
    || AMAZON_HOST_RE.test(host)
    || AMAZON_ECOMMERCE_RE.test(text);
  const isNonAmazonEcommerce = !isAmazonEcommerce && NON_AMAZON_ECOMMERCE_RE.test(text);
  return {
    isAmazonEcommerce,
    isNonAmazonEcommerce,
    reason: isAmazonEcommerce ? '命中亚马逊电商行业信号'
      : isNonAmazonEcommerce ? '命中非亚马逊电商/平台信号'
        : '未命中亚马逊电商行业信号',
  };
}

function assessCandidateSourceRelevance(candidate, sourceByUrl) {
  const urls = candidateSourceUrls(candidate);
  const sources = urls.map((url) => {
    const source = lookupSource(sourceByUrl, url);
    const assessment = assessSource(source);
    return { url, source, ...assessment };
  });
  const matchedCount = sources.filter((s) => !!s.source).length;
  const missingCount = sources.length - matchedCount;
  const amazonCount = sources.filter((s) => s.isAmazonEcommerce).length;
  const nonAmazonEcommerceCount = sources.filter((s) => s.isNonAmazonEcommerce).length;
  return {
    urls,
    sources,
    matchedCount,
    missingCount,
    amazonCount,
    nonAmazonEcommerceCount,
    hasAmazonEcommerceSource: amazonCount > 0,
    hasNonAmazonEcommerceSource: nonAmazonEcommerceCount > 0,
    hasOnlyAmazonEcommerceSources: urls.length > 0 && missingCount === 0 && amazonCount === urls.length,
  };
}

function priorityForScore(score) {
  if (score >= 85) return 'P0';
  if (score >= 70) return 'P1';
  return 'P2';
}

function applyCandidateSourceScoreGuard(candidate, relevance, { cap = 59 } = {}) {
  const originalScore = Math.round(Number(candidate.score) || 0);
  const guarded = { ...candidate, originalScore, rejected: false, reason: '' };
  if (!relevance.hasOnlyAmazonEcommerceSources) {
    const score = Math.min(originalScore, cap);
    guarded.score = score;
    if (candidate.contentValueScore != null) {
      guarded.contentValueScore = Math.min(Math.round(Number(candidate.contentValueScore) || 0), cap);
    }
    guarded.priority = priorityForScore(score);
    guarded.rejected = true;
    guarded.reason = relevance.urls.length === 0
      ? '候选未引用任何 sourceUrl，无法证明由亚马逊电商行业素材支撑'
      : `候选引用了非亚马逊电商行业素材或未匹配素材（Amazon ${relevance.amazonCount}/${relevance.urls.length}，missing ${relevance.missingCount}）`;
  }
  return guarded;
}

function buildSourceUrlMap(sourceItems) {
  const map = new Map();
  for (const item of sourceItems || []) {
    const url = canonicalUrl(item.source_url);
    if (url) map.set(url, item);
  }
  return map;
}

function sourceIdsForCandidate(candidate, sourceByUrl) {
  return candidateSourceUrls(candidate)
    .map((url) => lookupSource(sourceByUrl, url))
    .filter((source) => source && source.id)
    .map((source) => source.id);
}

module.exports = {
  assessCandidateSourceRelevance,
  applyCandidateSourceScoreGuard,
  buildSourceUrlMap,
  candidateSourceUrls,
  sourceIdsForCandidate,
};
