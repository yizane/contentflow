// validate_data_lib.js — 对象级校验（DB-only runtime 用，不读文件）
const fs = require('fs');
const path = require('path');

// 正文 AI/工作流痕迹禁词（runtime 唯一权威定义；legacy 文件型校验器有同款副本）
const BANNED_PHRASES = [
  '本次写作环境', '无法实时核查', '无法完成实时外部网页核查', '作为 AI', '我无法联网',
  '我的知识截止', '由于无法访问网页', '本模型', '训练数据', 'AI 生成', '需要用户自行核查',
];

const ROOT = path.resolve(__dirname, '..', '..');
let _articleSchema = null;
function articleSchemaDef() {
  if (_articleSchema) return _articleSchema;
  try {
    _articleSchema = JSON.parse(require('./config_lib').getDoc('schema:article.schema.json'));
  } catch (_) {
    _articleSchema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'article.schema.json'), 'utf8'));
  }
  return _articleSchema;
}

function bannedIn(text) {
  const noSpace = (text || '').replace(/\s+/g, '');
  return BANNED_PHRASES.filter((p) => noSpace.includes(p.replace(/\s+/g, '')));
}

// 文章 + 质量门
function validateArticleData(article, quality) {
  const issues = [];
  if (!article || typeof article !== 'object') return { ok: false, issues: ['article 不是对象'] };
  for (const f of articleSchemaDef().required) {
    if (article[f] === undefined || article[f] === null) issues.push(`article 缺少字段: ${f}`);
  }
  const md = typeof article.articleMarkdown === 'string' ? article.articleMarkdown : '';
  if (md.length <= 1500) issues.push(`articleMarkdown 长度不足: ${md.length}`);
  if (!Array.isArray(article.faqJson) || article.faqJson.length < 4) issues.push('faqJson 不足 4 条');
  if (!Array.isArray(article.sources) || article.sources.length < 1) issues.push('sources 至少 1 条');
  else {
    for (const f of ['title', 'sourceName', 'sourceUrl', 'retrievedAt', 'asOf', 'sourceType', 'sourceTrust']) {
      article.sources.forEach((s, i) => {
        if (!s || s[f] === undefined) issues.push(`sources[${i}] 缺少: ${f}`);
      });
    }
  }
  if (!md.includes('##')) issues.push('缺少 ## 二级标题');
  if (!/TL;DR|要点/i.test(md)) issues.push('缺少 TL;DR');
  if (!md.includes('|')) issues.push('缺少表格');
  if (!article.flyfusCta || !String(article.flyfusCta).trim()) issues.push('flyfusCta 为空');
  bannedIn(md).forEach((p) => issues.push(`articleMarkdown contains AI/workflow disclosure phrase: ${p}`));

  if (!quality || typeof quality !== 'object') {
    issues.push('quality 不是对象');
  } else {
    if (typeof quality.score !== 'number' || quality.score < 0 || quality.score > 100) issues.push(`quality.score 非法: ${quality.score}`);
    if (!['publish', 'revise', 'reject'].includes(quality.publishRecommendation)) issues.push(`quality.publishRecommendation 非法: ${quality.publishRecommendation}`);
    for (const d of ['searchIntent', 'informationGain', 'actionability', 'seo', 'geo', 'facts', 'brandFit']) {
      if (!quality.breakdown || typeof quality.breakdown[d] !== 'number') issues.push(`quality.breakdown.${d} 缺失`);
    }
  }

  // visualPlan：结构问题算 issue（schema 已要求），规范性问题算 warning（质量评分的 clarity 自然体现）
  const warnings = [];
  if (article.visualPlan !== undefined) {
    const vp = validateVisualPlan(article.visualPlan, md, article.category);
    issues.push(...vp.issues);
    warnings.push(...vp.warnings);
  }
  return { ok: issues.length === 0, issues, warnings };
}

// 事实核查
const FC_CATEGORY = ['amazon_official_policy', 'amazon_rufus_feature', 'google_search_policy', 'seo_geo_best_practice', 'marketplace_trend', 'flyfus_product_claim', 'operational_advice'];
const FC_GROUP = ['official_amazon', 'official_google', 'marketplace_news', 'seo_geo_ai_search', 'chinese_crossborder_news', 'internal_flyfus_data'];
function validateFactCheckData(fc) {
  const issues = [];
  const summary = { claims: 0, highRisk: 0, mediumRisk: 0, sourceNeeded: 0, mustFix: 0 };
  if (!fc || typeof fc !== 'object') return { ok: false, issues: ['fact_check 不是对象'], summary };
  if (!fc.articleTitle) issues.push('缺 articleTitle');
  if (!['low', 'medium', 'high'].includes(fc.overallRisk)) issues.push(`overallRisk 非法: ${fc.overallRisk}`);
  if (!['ready_after_minor_edits', 'needs_fact_sources', 'not_ready'].includes(fc.publishReadiness)) issues.push(`publishReadiness 非法: ${fc.publishReadiness}`);
  if (!Array.isArray(fc.mustFixBeforePublish)) issues.push('mustFixBeforePublish 非数组');
  if (!Array.isArray(fc.claims) || fc.claims.length < 1) {
    issues.push('claims 至少 1 条');
  } else {
    fc.claims.forEach((c, i) => {
      for (const f of ['claim', 'category', 'risk', 'sourceNeeded', 'recommendedSourceGroup', 'action', 'reason', 'suggestedRewrite']) {
        if (c[f] === undefined) issues.push(`claims[${i}] 缺少: ${f}`);
      }
      if (c.risk && !['low', 'medium', 'high'].includes(c.risk)) issues.push(`claims[${i}].risk 非法`);
      if (c.action && !['keep', 'soften', 'remove', 'cite_required'].includes(c.action)) issues.push(`claims[${i}].action 非法`);
      if (c.category && !FC_CATEGORY.includes(c.category)) issues.push(`claims[${i}].category 非法: ${c.category}`);
      if (c.recommendedSourceGroup && !FC_GROUP.includes(c.recommendedSourceGroup)) issues.push(`claims[${i}].recommendedSourceGroup 非法: ${c.recommendedSourceGroup}`);
      if (c.risk === 'high') summary.highRisk++;
      if (c.risk === 'medium') summary.mediumRisk++;
      if (c.sourceNeeded === true) summary.sourceNeeded++;
    });
    summary.claims = fc.claims.length;
  }
  summary.mustFix = Array.isArray(fc.mustFixBeforePublish) ? fc.mustFixBeforePublish.length : 0;
  return { ok: issues.length === 0, issues, summary };
}

// 渠道（沿用 validate_channel_outputs 的否定语境逻辑）
const PROMISE_PHRASES = ['保证排名', '保证被推荐', '保证被 Alexa', '保证被AI引用', '保证被 AI 引用', '保证 ACoS 下降', '保证ACoS下降', '百分百有效', '必定提升'];
const NEGATION = /(不要|不得|不能|不会|不再|别|避免|禁止|切勿|❌|不写|不承诺|没有|并非|不是|不)[^。！？!?\n]{0,24}$/;
function validateChannelData(data, channel) {
  const issues = [];
  if (!data || typeof data !== 'object') return { ok: false, issues: [`${channel} 不是对象`] };
  for (const f of ['channel', 'title', 'titleCandidates', 'contentMarkdown', 'notes', 'status']) {
    if (data[f] === undefined) issues.push(`缺少字段: ${f}`);
  }
  if (data.channel !== channel) issues.push(`channel 不匹配: ${data.channel}`);
  if (typeof data.contentMarkdown !== 'string' || data.contentMarkdown.length < 200) issues.push('contentMarkdown 过短');
  if (channel === 'xiaohongshu' && (!Array.isArray(data.titleCandidates) || data.titleCandidates.length < 5)) issues.push('xiaohongshu 需 5 个标题候选');
  if (channel === 'douyin' && !/【镜头/.test(data.contentMarkdown || '')) issues.push('douyin 缺【镜头提示】');
  const md = (data.contentMarkdown || '') + ' ' + (data.title || '');
  bannedIn(md).forEach((p) => issues.push(`含 AI 工作流痕迹: "${p}"`));
  const mdNoSpace = md.replace(/\s+/g, '');
  for (const p of PROMISE_PHRASES) {
    const needle = p.replace(/\s+/g, '');
    let idx = mdNoSpace.indexOf(needle);
    let violated = false;
    while (idx !== -1) {
      if (!NEGATION.test(mdNoSpace.slice(Math.max(0, idx - 32), idx))) { violated = true; break; }
      idx = mdNoSpace.indexOf(needle, idx + 1);
    }
    if (violated) issues.push(`含承诺类禁词: "${p}"`);
  }
  return { ok: issues.length === 0, issues };
}

// 候选主题
const TC_CATEGORY = ['rufus', 'listing-geo', 'product-research', 'ppc-acos', 'keyword', 'ai-search-ops'];
function validateTopicCandidatesData(data, keywordSet) {
  const issues = [];
  const warnings = [];
  if (!data || !Array.isArray(data.candidates) || data.candidates.length < 5) {
    return { ok: false, issues: ['candidates 至少 5 条'], warnings };
  }
  const seen = new Set();
  data.candidates.forEach((c, i) => {
    for (const f of ['topic', 'primaryKeyword', 'secondaryKeywords', 'category', 'contentAngle', 'businessAngle', 'sourceUrls', 'score', 'priority', 'status', 'reason', 'rejectRisk']) {
      if (c[f] === undefined) issues.push(`candidates[${i}] 缺少: ${f}`);
    }
    if (c.category && !TC_CATEGORY.includes(c.category)) issues.push(`candidates[${i}].category 非法: ${c.category}`);
    if (c.priority && !['P0', 'P1', 'P2'].includes(c.priority)) issues.push(`candidates[${i}].priority 非法`);
    if (typeof c.score !== 'number' || c.score < 0 || c.score > 100) issues.push(`candidates[${i}].score 非法`);
    if (/Rufus\s*时代/.test(c.topic || '')) issues.push(`candidates[${i}] 过期口径 "Rufus 时代"`);
    if (keywordSet && c.primaryKeyword && !keywordSet.has(c.primaryKeyword)) warnings.push(`candidates[${i}].primaryKeyword 不在关键词库: ${c.primaryKeyword}`);
    // 内容分类字段：缺失只警告（入库时会回退规则分类），不阻断
    for (const f of ['contentType', 'businessCategory', 'topicCluster']) {
      if (c[f] === undefined) warnings.push(`candidates[${i}] 缺少分类字段 ${f}（将回退规则分类）`);
    }
    const norm = (c.topic || '').replace(/\s+/g, '');
    if (seen.has(norm)) issues.push(`candidates[${i}].topic 重复`);
    seen.add(norm);
  });
  return { ok: issues.length === 0, issues, warnings };
}

// 来源补全
const OFFICIAL_HOST_RE = /(^|\.)((aboutamazon|amazon|sellercentral\.amazon)\.com|advertising\.amazon\.com|science\.amazon\.com|developers\.google\.com|blog\.google|support\.google\.com)$/;
const FAKE_URL_RE = /(example\.com|placeholder|your-?url|fake|lorem|\.\.\.|<|>|\s)/i;
function validateSourceResolutionData(data) {
  const issues = [];
  const summary = { items: 0, resolved: 0, partiallyResolved: 0, notFound: 0, needsManualReview: 0 };
  if (!data || typeof data !== 'object') return { ok: false, issues: ['不是对象'], summary };
  if (!data.articleId) issues.push('缺 articleId');
  if (!['resolved', 'partially_resolved', 'needs_manual_review'].includes(data.overallResolutionStatus)) issues.push('overallResolutionStatus 非法');
  if (typeof data.readyForRevision !== 'boolean') issues.push('readyForRevision 非布尔');
  if (!Array.isArray(data.items) || data.items.length < 1) return { ok: false, issues: [...issues, 'items 至少 1 条'], summary };
  data.items.forEach((it, i) => {
    const src = it.source || {};
    if (!['resolved', 'partially_resolved', 'not_found', 'needs_manual_review'].includes(it.resolvedStatus)) issues.push(`items[${i}].resolvedStatus 非法`);
    if (src.sourceTrust === 'internal_product_claim') {
      if (!/flyfus_[a-z_]+/.test(`${it.notes || ''} ${it.evidenceSummary || ''}`)) issues.push(`items[${i}] internal_product_claim 未注明 claim id`);
    }
    if (it.resolvedStatus === 'resolved' && src.sourceTrust !== 'internal_product_claim') {
      if (!src.url || !/^https?:\/\//.test(src.url)) issues.push(`items[${i}] resolved 但 url 缺失/非法`);
      else if (FAKE_URL_RE.test(src.url)) issues.push(`items[${i}].url 疑似假 URL: ${src.url}`);
    }
    if (src.sourceTrust === 'primary_fact' && src.url) {
      try {
        const host = new URL(src.url).hostname;
        if (!OFFICIAL_HOST_RE.test(host) && !(it.notes || '').trim()) issues.push(`items[${i}] primary_fact 非官方域名且无 notes: ${host}`);
      } catch (_) {
        issues.push(`items[${i}].url 无法解析`);
      }
    }
    if ((it.resolvedStatus === 'not_found' || it.resolvedStatus === 'needs_manual_review') && !(it.suggestedRewrite || '').trim()) {
      issues.push(`items[${i}] 未解决但缺降级 suggestedRewrite`);
    }
    if (it.resolvedStatus === 'resolved') summary.resolved++;
    else if (it.resolvedStatus === 'partially_resolved') summary.partiallyResolved++;
    else if (it.resolvedStatus === 'not_found') summary.notFound++;
    else summary.needsManualReview++;
  });
  summary.items = data.items.length;
  return { ok: issues.length === 0, issues, summary };
}

// 修订稿（对象级；origLen 容差与原实现一致）
function validateRevisedArticleData(revised, original, resolution) {
  const issues = [];
  const warnings = [];
  const base = validateArticleData(revised, { score: 0, publishRecommendation: 'revise', breakdown: { searchIntent: 0, informationGain: 0, actionability: 0, seo: 0, geo: 0, facts: 0, brandFit: 0 } });
  // 只取 article 部分的 issues（quality 是占位）
  base.issues.filter((i) => !i.startsWith('quality')).forEach((i) => issues.push(i));
  if (revised.slug !== original.slug) issues.push(`slug 不应变更: ${original.slug} → ${revised.slug}`);
  if (revised.primaryKeyword !== original.primaryKeyword) issues.push('primaryKeyword 不应变更');
  const origLen = (original.articleMarkdown || '').length;
  const len = (revised.articleMarkdown || '').length;
  if (len < origLen * 0.7) issues.push(`修订后缩水过多: ${origLen} → ${len}`);
  else if (len < origLen * 0.85) warnings.push(`修订后明显变短: ${origLen} → ${len}`);
  if (resolution) {
    const urls = new Set((revised.sources || []).map((s) => s.sourceUrl));
    for (const it of resolution.items || []) {
      if (it.resolvedStatus === 'resolved' && it.source && it.source.url && !urls.has(it.source.url)) {
        issues.push(`resolved 来源未加入 sources: ${it.source.url}`);
      }
    }
  }
  return { ok: issues.length === 0, issues, warnings };
}

// SEO/GEO 评分组（seo/geo/dual 三对象）
const SEO_DIMS = { searchIntentMatch: 15, keywordTargeting: 15, serpDifferentiation: 15, titleMetaOptimization: 10, headingStructure: 10, internalLinkOpportunity: 10, schemaReadiness: 10, freshnessAndSource: 10, readability: 5 };
const GEO_DIMS = { answerFirst: 15, extractableStructure: 15, entityClarity: 15, citationReadiness: 15, questionCoverage: 10, comparisonAndCriteria: 10, factualCaution: 10, chunkability: 10 };
function checkBreakdown(data, dims, scoreKey, label, issues) {
  let sum = 0;
  for (const [d, max] of Object.entries(dims)) {
    const v = data.breakdown ? data.breakdown[d] : undefined;
    if (typeof v !== 'number' || v < 0 || v > max) issues.push(`${label}.breakdown.${d} 非法: ${v}`);
    else sum += v;
  }
  if (Math.abs((data[scoreKey] || 0) - sum) > 2) issues.push(`${label}.${scoreKey}(${data[scoreKey]}) 与加总(${sum}) 偏差>2`);
}
function validateScoreSetData({ seo, geo, dual }, weights) {
  const issues = [];
  if (!seo || !geo || !dual) return { ok: false, issues: ['缺少 seo/geo/dual 之一'], summary: {} };
  checkBreakdown(seo, SEO_DIMS, 'seoScore', 'seo', issues);
  checkBreakdown(geo, GEO_DIMS, 'geoScore', 'geo', issues);
  for (const f of ['overallScore', 'seoScore', 'geoScore', 'factScore', 'businessFitScore', 'readabilityScore']) {
    if (typeof dual[f] !== 'number' || dual[f] < 0 || dual[f] > 100) issues.push(`dual.${f} 非法`);
  }
  if (!['publish', 'revise', 'reject', 'ready_for_review'].includes(dual.recommendation)) issues.push('dual.recommendation 非法');
  if (dual.seoScore !== seo.seoScore) issues.push('dual.seoScore 与 seo 不一致');
  if (dual.geoScore !== geo.geoScore) issues.push('dual.geoScore 与 geo 不一致');
  const w = weights[dual.strategy];
  if (w) {
    const expected = Math.round(w.seo * dual.seoScore + w.geo * dual.geoScore + w.fact * dual.factScore + w.businessFit * dual.businessFitScore + w.readability * dual.readabilityScore);
    if (Math.abs(dual.overallScore - expected) > 3) issues.push(`overall(${dual.overallScore}) 与加权值(${expected}) 偏差>3`);
  }
  if (dual.factScore < 60 && ['publish', 'ready_for_review'].includes(dual.recommendation)) issues.push('factScore<60 不得 publish/ready_for_review');
  bannedIn(JSON.stringify([seo.issues, geo.issues, dual.summary, dual.mustFix])).forEach((p) => issues.push(`评语含 AI 痕迹: ${p}`));
  const summary = { overallScore: dual.overallScore, seoScore: dual.seoScore, geoScore: dual.geoScore, recommendation: dual.recommendation };
  return { ok: issues.length === 0, issues, summary };
}

// 文章质量主评分校验
const AQ_DIMS = [['sellerPainFit', 20], ['actionability', 20], ['informationGain', 20], ['originality', 10], ['clarity', 10], ['evidenceUse', 10], ['businessUsefulness', 10]];
function validateArticleQualityData(data) {
  const issues = [];
  if (!data || typeof data !== 'object') return { ok: false, issues: ['不是对象'] };
  const b = data.breakdown || {};
  let sum = 0;
  for (const [k, max] of AQ_DIMS) {
    if (typeof b[k] !== 'number' || b[k] < 0 || b[k] > max) issues.push(`breakdown.${k} 非法（0-${max}）`);
    else sum += b[k];
  }
  if (typeof data.articleQualityScore !== 'number' || data.articleQualityScore < 0 || data.articleQualityScore > 100) issues.push('articleQualityScore 非法');
  else if (Math.abs(data.articleQualityScore - sum) > 5) issues.push(`articleQualityScore(${data.articleQualityScore}) 与维度和(${sum})偏差过大`);
  else if (data.articleQualityScore !== sum) data.articleQualityScore = sum; // 小幅加法误差：以维度和为准
  if (!['excellent', 'good', 'revise', 'reject'].includes(data.qualityRecommendation)) issues.push('qualityRecommendation 非法');
  for (const f of ['strengths', 'issues', 'mustFix', 'niceToHave']) {
    if (!Array.isArray(data[f])) issues.push(`${f} 必须是数组`);
  }
  return { ok: issues.length === 0, issues };
}

// 视觉规划校验（缺失不 reject，只 warning + 质量分自然扣 clarity）
const VISUAL_TYPES = ['diagram', 'table_image', 'checklist_card', 'process_flow', 'comparison_chart', 'screenshot_placeholder', 'data_chart'];
function validateVisualPlan(visualPlan, articleMarkdown, contentType) {
  const issues = [];
  const warnings = [];
  if (!Array.isArray(visualPlan) || visualPlan.length === 0) {
    return { ok: true, issues: [], warnings: ['visualPlan 缺失（建议每篇至少 2 个视觉规划）'] };
  }
  if (visualPlan.length < 2) warnings.push(`visualPlan 仅 ${visualPlan.length} 个（建议至少 2 个）`);
  const md = articleMarkdown || '';
  visualPlan.forEach((v, i) => {
    for (const f of ['id', 'placement', 'visualType', 'title', 'purpose', 'description', 'caption', 'altText', 'imagePrompt']) {
      if (!v[f]) issues.push(`visualPlan[${i}] 缺少 ${f}`);
    }
    if (v.visualType && !VISUAL_TYPES.includes(v.visualType)) issues.push(`visualPlan[${i}].visualType 非法: ${v.visualType}`);
    if (v.id && !md.includes(v.id) && !(v.title && md.includes(v.title))) warnings.push(`visualPlan[${i}]（${v.id}）未在正文中引用占位标记`);
    if (v.altText && /关键词|keyword/i.test(v.altText) === false && v.altText.length < 8) warnings.push(`visualPlan[${i}].altText 过短，应描述图片内容`);
    if (v.visualType === 'screenshot_placeholder' && /真实截图|实际截图|如图所示的后台/.test(v.description || '')) issues.push(`visualPlan[${i}] screenshot_placeholder 不得声称已有真实截图`);
  });
  if (contentType === 'operation_guide' && !visualPlan.some((v) => ['process_flow', 'checklist_card'].includes(v.visualType))) {
    warnings.push('操作指南建议至少一个 process_flow 或 checklist_card');
  }
  if (contentType === 'trend_analysis' && !visualPlan.some((v) => ['comparison_chart', 'diagram'].includes(v.visualType))) {
    warnings.push('趋势解读建议至少一个 comparison_chart 或 diagram');
  }
  if (['market_report'].includes(contentType) && !visualPlan.some((v) => v.visualType === 'data_chart')) {
    warnings.push('数据/报告类建议至少一个 data_chart');
  }
  return { ok: issues.length === 0, issues, warnings };
}

module.exports = { validateArticleData, validateFactCheckData, validateChannelData, validateTopicCandidatesData, validateSourceResolutionData, validateRevisedArticleData, validateScoreSetData, validateArticleQualityData, validateVisualPlan, bannedIn };
