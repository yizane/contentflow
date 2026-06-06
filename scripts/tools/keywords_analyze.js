#!/usr/bin/env node
// keywords_analyze.js — 关键词库分布体检（结构性偏置检测）
// 用法: npm run keywords:analyze [-- --json]
// 读 config/keywords.csv，按 cluster / priority / 推断 business_category / 认知型词占比输出告警与建议。
const fs = require('fs');
const path = require('path');
const { clusterCategoryMap } = require('../lib/topic_portfolio_lib');

const ROOT = path.resolve(__dirname, '..', '..');
const COGNITIVE_RE = /(是什么|什么是|多少算正常|renamed|改名)/;

function main() {
  const csv = fs.readFileSync(path.join(ROOT, 'config', 'keywords.csv'), 'utf8').trim().split('\n');
  const rows = csv.slice(1).map((l) => {
    const [keyword, cluster, intent, priority, stage, business_angle] = l.split(',').map((x) => (x || '').trim());
    return { keyword, cluster, intent, priority, stage, business_angle };
  }).filter((r) => r.keyword);

  const CLUSTER_TO_CAT = clusterCategoryMap();
  const clusters = {};
  const businessCategories = {};
  const p0ByCategory = {};
  let p0Total = 0;
  let cognitiveP0 = 0;
  const missingFields = [];

  for (const r of rows) {
    clusters[r.cluster] = (clusters[r.cluster] || 0) + 1;
    const cat = CLUSTER_TO_CAT[r.cluster] || 'other';
    businessCategories[cat] = (businessCategories[cat] || 0) + 1;
    if (r.priority === 'P0') {
      p0Total++;
      p0ByCategory[cat] = (p0ByCategory[cat] || 0) + 1;
      if (COGNITIVE_RE.test(r.keyword)) cognitiveP0++;
    }
    if (!r.cluster || !r.intent || !r.priority || !r.stage || !r.business_angle) missingFields.push(r.keyword);
  }

  const total = rows.length;
  const share = (cat) => (businessCategories[cat] || 0) / total;
  const warnings = [];
  const recommendations = [];

  const aiShare = share('amazon_ai_shopping') + share('listing_geo');
  if (aiShare > 0.35) {
    warnings.push(`Amazon AI Shopping + Listing GEO 合计占比 ${(aiShare * 100).toFixed(0)}% > 35%`);
    recommendations.push('降低 Alexa/Listing 系关键词占比：扩充其他分类，或停用部分同质词');
  }
  for (const [cat, c] of Object.entries(p0ByCategory)) {
    if (c / Math.max(1, p0Total) > 0.4) {
      warnings.push(`P0 关键词 ${((c / p0Total) * 100).toFixed(0)}% 集中在 ${cat}（${c}/${p0Total}）`);
      recommendations.push(`把 ${cat} 的部分 P0 降级，或给其他分类补 P0 词`);
    }
  }
  const minReq = [['ppc_acos', 20], ['product_research', 20], ['keyword_intent', 15], ['review_qa', 5], ['account_compliance', 5], ['fba_inventory', 5], ['brand_growth', 5]];
  for (const [cat, min] of minReq) {
    const c = businessCategories[cat] || 0;
    if (c < min) {
      warnings.push(`${cat} 关键词仅 ${c} 个（建议 ≥ ${min}）`);
      recommendations.push(`为 ${cat} 补充贴合 Flyfus 业务的关键词至 ${min} 个以上`);
    }
  }
  if (cognitiveP0 >= 3) {
    warnings.push(`「是什么/什么是」类认知型 P0 词有 ${cognitiveP0} 个（认知型词适合 P1/P2，不应占用主选题优先级）`);
    recommendations.push('把认知型（是什么/什么是）关键词降为 P1/P2');
  }
  if (missingFields.length) warnings.push(`${missingFields.length} 个关键词字段不全: ${missingFields.slice(0, 3).join('、')}…`);

  const out = {
    ok: true, total,
    clusters: Object.fromEntries(Object.entries(clusters).sort((a, b) => b[1] - a[1])),
    businessCategories: Object.fromEntries(Object.entries(businessCategories).sort((a, b) => b[1] - a[1])),
    businessCategoryShare: Object.fromEntries(Object.entries(businessCategories).sort((a, b) => b[1] - a[1]).map(([k, c]) => [k, `${((c / total) * 100).toFixed(0)}%`])),
    p0Total, p0ByCategory, cognitiveP0,
    warnings, recommendations,
  };
  console.log(JSON.stringify(out, null, 2));
  if (warnings.length) process.exitCode = 0; // 体检工具：告警不算失败
}

main();
