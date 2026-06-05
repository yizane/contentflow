// taxonomy_lib.js — 内容三层分类体系（content_type / business_category / topic_cluster）
// 来源：config/content_taxonomy.yaml（经 config:sync 入库后从 app_configs 读，文件为 fallback）。
// 注意：source_group 表示来源分组，与内容分类是两套体系，不能混用。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

// ---------- 轻量 YAML 解析（结构固定：section → key → 标量字段，与仓库其他 yaml 解析同风格）----------
function parseTaxonomyYaml(text) {
  const out = { version: 1, content_types: {}, business_categories: {}, topic_clusters: {} };
  let section = null;
  let entry = null;
  const unquote = (s) => s.replace(/^["']|["']$/g, '');
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const ind = line.length - line.trimStart().length;
    if (ind === 0) {
      const m = t.match(/^([\w]+)\s*:\s*(.*)$/);
      if (!m) continue;
      if (m[2]) { out[m[1]] = isNaN(Number(m[2])) ? unquote(m[2]) : Number(m[2]); section = null; }
      else { section = m[1]; if (!out[section]) out[section] = {}; }
      entry = null;
      continue;
    }
    if (!section) continue;
    if (ind === 2) {
      const m = t.match(/^([\w]+)\s*:\s*$/);
      if (m) { entry = {}; out[section][m[1]] = entry; }
      continue;
    }
    if (ind >= 4 && entry) {
      const m = t.match(/^([\w]+)\s*:\s*(.+)$/);
      if (m) entry[m[1]] = unquote(m[2].trim());
    }
  }
  return out;
}

let cached = null;
function loadTaxonomy() {
  if (cached) return cached;
  let text = null;
  try {
    // 优先 DB（config_lib 须已 ensureInit；未初始化时走文件）
    text = require('./config_lib').getDoc('content_taxonomy');
  } catch (_) {
    const p = path.join(ROOT, 'config', 'content_taxonomy.yaml');
    if (fs.existsSync(p)) text = fs.readFileSync(p, 'utf8');
  }
  if (!text) throw new Error('content_taxonomy.yaml 缺失（DB 与文件均无）');
  cached = parseTaxonomyYaml(text);
  return cached;
}

function contentTypes() { return Object.keys(loadTaxonomy().content_types); }
function businessCategories() { return Object.keys(loadTaxonomy().business_categories); }
function topicClusters() { return Object.keys(loadTaxonomy().topic_clusters); }

function labelOf(kind, key) {
  if (!key) return null;
  const t = loadTaxonomy();
  const map = { content_type: t.content_types, business_category: t.business_categories, topic_cluster: t.topic_clusters }[kind];
  return (map && map[key] && map[key].label_zh) || key;
}

// cluster → 所属 business_category
function clusterCategory(cluster) {
  const t = loadTaxonomy();
  return (t.topic_clusters[cluster] && t.topic_clusters[cluster].business_category) || null;
}

// 校验 + 纠偏：枚举外的值丢弃；cluster 与 category 不一致时置空 cluster
function normalizeClassification(c) {
  if (!c) return null;
  const out = {
    contentType: contentTypes().includes(c.contentType) ? c.contentType : null,
    businessCategory: businessCategories().includes(c.businessCategory) ? c.businessCategory : null,
    topicCluster: topicClusters().includes(c.topicCluster) ? c.topicCluster : null,
    confidence: typeof c.confidence === 'number' ? Math.max(0, Math.min(1, c.confidence)) : null,
    reason: String(c.reason || '').slice(0, 900) || null,
  };
  if (out.topicCluster && out.businessCategory && clusterCategory(out.topicCluster) !== out.businessCategory) {
    out.topicCluster = null;
  }
  if (out.topicCluster && !out.businessCategory) out.businessCategory = clusterCategory(out.topicCluster);
  return out;
}

// prompt 注入用的 taxonomy 摘要块
function taxonomyPromptBlock() {
  const t = loadTaxonomy();
  const fmt = (map, extra) => Object.entries(map)
    .map(([k, v]) => `- ${k}：${v.label_zh} — ${v.description || ''}${extra ? extra(v) : ''}`)
    .join('\n');
  return `### content_types（内容形态，必选其一）
${fmt(t.content_types)}

### business_categories（业务主题，必选其一）
${fmt(t.business_categories)}

### topic_clusters（主题簇，可选；必须与 business_category 一致，无合适项返回 ""）
${Object.entries(t.topic_clusters).map(([k, v]) => `- ${k}：${v.label_zh}（属于 ${v.business_category}）`).join('\n')}`;
}

// ---------- 规则分类 ----------
// 输入：{ title, summary, sourceGroup, sourceName }
// 输出：{ contentType, businessCategory, topicCluster, confidence, reason } 或 null（完全无信号，交给 AI）
// 原则：标题/摘要的内容信号优先；source_group 只提供低置信度倾向；中文源绝不自动归 news_flash。
const CT_RULES = [
  { re: /(rufus\s+renamed|alexa\s*for\s*shopping|launch(ed|es)?|introduc(ed|es|ing)|rolls?\s*out|上线|发布|推出|更名|改名|整合)/i, type: 'product_update', conf: 0.86, why: '标题含功能上线/更名/整合信号' },
  { re: /(how\s+to|guide|checklist|tutorial|step[-\s]by[-\s]step|playbook|方法|如何|教程|攻略|SOP|清单|指南|步骤)/i, type: 'operation_guide', conf: 0.87, why: '标题含可执行方法/教程/清单信号' },
  { re: /(warning|risk|ban(ned)?|suspend(ed|sion)?|account\s*health|violation|deactivat|封号|违规|风险|警告|申诉|停用|黑科技|避坑)/i, type: 'risk_warning', conf: 0.88, why: '标题含违规/封号/风险信号' },
  { re: /(policy|fee\s*(change|update)|compliance|regulation|terms\s+of\s+service|新规|政策|费率|合规|条款|规则(变更|更新))/i, type: 'policy_update', conf: 0.86, why: '标题含平台政策/费率/合规信号' },
  { re: /(report|survey|study|data\s*(show|reveal)|statistics|benchmark|报告|调研|数据显示|白皮书|洞察)/i, type: 'market_report', conf: 0.82, why: '标题含报告/调研/数据信号' },
  { re: /(trend|future\s+of|why\s+.+\s+is|意味着什么|趋势|解读|变局|展望|影响分析)/i, type: 'trend_analysis', conf: 0.78, why: '标题含趋势/解读信号' },
  { re: /(case\s*stud(y|ies)|success\s+story|复盘|案例|实战|经验分享)/i, type: 'case_study', conf: 0.85, why: '标题含案例/复盘信号' },
  { re: /(review(ed|s)?\s+(of|:)|vs\.?\s|versus|alternative(s)?\s+to|comparison|对比|测评|评测|替代)/i, type: 'tool_review', conf: 0.82, why: '标题含测评/对比/替代信号' },
];

const BC_RULES = [
  { re: /(rufus|alexa\s*for\s*shopping|amazon\s*ai\s*shopping|ai\s*overviews?|agentic|ai\s*导购|AI\s*购物)/i, cat: 'amazon_ai_shopping', conf: 0.9, why: '命中 Amazon AI Shopping 关键词' },
  { re: /(listing|a\+\s*content|bullet\s*points?|product\s*(detail\s*)?page|五点|商品页|详情页|图文|语义(结构|优化))/i, cat: 'listing_geo', conf: 0.85, why: '命中 Listing/商品页关键词' },
  { re: /(ppc|acos|cpc|sponsored\s*(products?|brands?|display)|ad(vertising)?\s*(campaign|spend)|广告|竞价|投放)/i, cat: 'ppc_acos', conf: 0.88, why: '命中广告/PPC 关键词' },
  { re: /(keyword|search\s*term|long[-\s]tail|intent|关键词|搜索词|长尾词|意图词|场景词)/i, cat: 'keyword_intent', conf: 0.84, why: '命中关键词/意图词关键词' },
  { re: /(product\s*(research|development|opportunity)|niche|blue\s*ocean|sourcing|选品|蓝海|新品开发|类目机会|未满足需求)/i, cat: 'product_research', conf: 0.86, why: '命中选品/产品开发关键词' },
  { re: /(reviews?\b|q&a|rating|feedback|return\s*(rate|reason)|差评|评论|问答|退货|买家(疑虑|反馈))/i, cat: 'review_qa', conf: 0.82, why: '命中 Review/Q&A 关键词' },
  { re: /(account\s*health|suspend|appeal|ban(ned)?|compliance|violation|封号|申诉|账号(健康|安全)|违规|合规)/i, cat: 'account_compliance', conf: 0.86, why: '命中账号健康/合规关键词' },
  { re: /(fba\b|fulfillment|inventory|warehous|storage\s*fee|logistics|物流|库存|备货|仓储|头程)/i, cat: 'fba_inventory', conf: 0.86, why: '命中 FBA/物流/库存关键词' },
  { re: /(brand\s*(registry|store)|off[-\s]amazon|influencer|deal|prime\s*day|black\s*friday|品牌(备案|旗舰店)|站外|红人|大促|旺季)/i, cat: 'brand_growth', conf: 0.82, why: '命中品牌/站外/增长关键词' },
  { re: /(ai\s*tool|chatgpt|claude|gpt|copilot|erp\b|saas|automation\s*tool|工具(推荐|测评|教程)|AI\s*工具)/i, cat: 'ai_tools', conf: 0.8, why: '命中 AI/运营工具关键词' },
  { re: /(marketplace|seller\s*(news|update)|amazon\s*(announce|update|news)|平台(政策|动态)|卖家(新闻|生态))/i, cat: 'marketplace_policy', conf: 0.72, why: '命中平台动态关键词' },
];

// topic_cluster 细分规则（在 businessCategory 命中后再细化）
const CLUSTER_RULES = [
  { re: /(alexa\s*for\s*shopping|amazon\s*ai\s*shopping)/i, cluster: 'alexa_for_shopping_listing' },
  { re: /(rufus)/i, cluster: 'rufus_question_data' },
  { re: /(listing.*(语义|semantic|structure|schema)|(语义|semantic).*listing|可抽取|extractab)/i, cluster: 'listing_semantic_structure' },
  { re: /((ppc|广告|sponsored).*(intent|意图|转化)|(intent|意图词).*(ppc|广告))/i, cluster: 'ppc_intent_keywords' },
  { re: /(未满足需求|unmet\s*need|product\s*opportunit|蓝海|选品机会)/i, cluster: 'product_opportunity_mining' },
  { re: /(封号|违规|账号安全|account\s*health|suspend|compliance\s*risk)/i, cluster: 'compliance_risk_warning' },
];

// source_group 先验（低置信度，仅当内容无信号时提供倾向；中文源不给 contentType 先验 → 交 AI）
const GROUP_PRIORS = {
  official_amazon: { contentType: 'policy_update', businessCategory: 'marketplace_policy', conf: 0.5, why: 'official_amazon 来源先验（官方公告/政策居多）' },
  official_google: { contentType: 'policy_update', businessCategory: 'marketplace_policy', conf: 0.45, why: 'official_google 来源先验' },
  community_signals: { contentType: 'qa_discussion', businessCategory: 'review_qa', conf: 0.6, why: 'community_signals 社区来源先验（讨论/问答居多）' },
  seo_geo_ai_search: { contentType: 'trend_analysis', businessCategory: 'listing_geo', conf: 0.45, why: 'seo_geo_ai_search 来源先验' },
  amazon_seller_tools_blogs: { contentType: 'operation_guide', businessCategory: 'ai_tools', conf: 0.4, why: '卖家工具博客来源先验' },
  marketplace_news: { contentType: 'news_flash', businessCategory: 'marketplace_policy', conf: 0.45, why: 'marketplace_news 来源先验' },
  // chinese_crossborder_news / search_queries：不给 contentType 先验，必须看内容（规则 8）
};

const NEWSY_RE = /(announc|breaking|launch|update[sd]?|news|快讯|宣布|官宣|重磅)/i;

function classifyByRules({ title = '', summary = '', sourceGroup = null, sourceName = null }) {
  const text = `${title} ${summary || ''}`;
  const reasons = [];
  let contentType = null;
  let ctConf = 0;
  let businessCategory = null;
  let bcConf = 0;

  for (const r of CT_RULES) {
    if (r.re.test(text)) { contentType = r.type; ctConf = r.conf; reasons.push(r.why); break; }
  }
  for (const r of BC_RULES) {
    if (r.re.test(text)) { businessCategory = r.cat; bcConf = r.conf; reasons.push(r.why); break; }
  }

  // community_signals：默认问答讨论，除非标题明显是新闻
  if (!contentType && sourceGroup === 'community_signals') {
    if (NEWSY_RE.test(title)) { contentType = 'news_flash'; ctConf = 0.6; reasons.push('社区来源但标题为新闻信号'); }
    else { contentType = 'qa_discussion'; ctConf = 0.72; reasons.push('community_signals 社区来源（非新闻标题）'); }
  }

  // 来源先验补缺（低置信度；中文源不补 contentType）
  const prior = GROUP_PRIORS[sourceGroup];
  if (prior) {
    if (!contentType && prior.contentType) { contentType = prior.contentType; ctConf = prior.conf; reasons.push(prior.why); }
    if (!businessCategory && prior.businessCategory) { businessCategory = prior.businessCategory; bcConf = Math.min(prior.conf, 0.5); reasons.push(`${prior.why}（业务分类倾向）`); }
  }

  // official_amazon + 政策词强化
  if (sourceGroup === 'official_amazon' && /policy|fee|compliance|政策|费率|合规/i.test(text)) {
    contentType = 'policy_update'; ctConf = Math.max(ctConf, 0.88);
    if (!businessCategory) { businessCategory = 'marketplace_policy'; bcConf = 0.8; }
    reasons.push('official_amazon 官方来源 + 政策费率词');
  }

  if (!contentType && !businessCategory) return null; // 无任何信号 → AI

  // topic_cluster 细化（须与 businessCategory 一致）
  let topicCluster = null;
  for (const r of CLUSTER_RULES) {
    if (r.re.test(text)) {
      const cat = clusterCategory(r.cluster);
      if (!businessCategory || businessCategory === cat) {
        topicCluster = r.cluster;
        if (!businessCategory) { businessCategory = cat; bcConf = 0.75; }
        break;
      }
    }
  }

  // 综合置信度：两个维度都齐才有高置信度；缺一维就压低（强制走 AI 复核）
  const confidence = contentType && businessCategory ? Math.min(ctConf, bcConf) : Math.min(ctConf || bcConf, 0.6) * 0.8;
  return normalizeClassification({
    contentType, businessCategory, topicCluster,
    confidence: Number(confidence.toFixed(4)),
    reason: `[rules] ${reasons.join('；') || '来源先验'}`,
  });
}

module.exports = {
  loadTaxonomy, parseTaxonomyYaml, contentTypes, businessCategories, topicClusters,
  labelOf, clusterCategory, normalizeClassification, taxonomyPromptBlock, classifyByRules,
};
