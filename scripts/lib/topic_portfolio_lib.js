// topic_portfolio_lib.js — Topic Portfolio Balancer（Phase 12B）
// 选题从「raw_score 最高者胜」变成「组合最值得者胜」：
//   selection_score = raw_score - 饱和惩罚 + 组合奖励
// 硬配额（主题簇/业务分类/关键词/重复度）拦截的高分候选 → deferred（窗口后自动回池），不是 rejected。
// 所有决策（扣分/加分/跳过原因）写 topic_candidates.portfolio_debug_json + workflow_events，Viewer 可见。
const path = require('path');
const fs = require('fs');
const my = require('./mysql_lib');
const { loadPolicy } = require('./production_policy_lib');
const { decideTopicDedupe, findMostSimilar, topicDedupePolicy } = require('./topic_dedupe_lib');
const trace = require('./trace_lib');
const runtime = require('./workflow_runtime_lib');

const ROOT = path.resolve(__dirname, '..', '..');

// ---------- policy 解析（content_portfolio.yaml：标量段 + map-of-maps 段）----------
function parsePortfolioYaml(text) {
  const out = {};
  let section = null;
  let sub = null;
  const coerce = (v) => {
    const s = String(v).trim().replace(/^["']|["']$/g, '');
    if (s === 'true') return true;
    if (s === 'false') return false;
    return s !== '' && !isNaN(Number(s)) ? Number(s) : s;
  };
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const ind = line.length - line.trimStart().length;
    const kv = t.match(/^([\w]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    if (ind === 0) {
      if (kv[2]) { out[kv[1]] = coerce(kv[2]); section = null; }
      else { section = kv[1]; out[section] = {}; }
      sub = null;
      continue;
    }
    if (!section) continue;
    if (ind === 2) {
      if (kv[2]) { out[section][kv[1]] = coerce(kv[2]); sub = null; }
      else { sub = {}; out[section][kv[1]] = sub; }
      continue;
    }
    if (ind >= 4 && sub && kv[2]) sub[kv[1]] = coerce(kv[2]);
  }
  return out;
}

let cachedPolicy = null;
function loadContentPortfolioPolicy() {
  if (cachedPolicy) return cachedPolicy;
  let text = null;
  try {
    text = require('./config_lib').getDoc('content_portfolio');
  } catch (_) {
    const p = path.join(ROOT, 'config', 'content_portfolio.yaml');
    if (fs.existsSync(p)) text = fs.readFileSync(p, 'utf8');
  }
  if (!text) throw new Error('content_portfolio.yaml 缺失（DB 与文件均无）');
  cachedPolicy = parsePortfolioYaml(text);
  return cachedPolicy;
}

// ---------- 组合统计 ----------
function dtStr(ms) { return new Date(ms).toISOString().slice(0, 23).replace('T', ' '); }

async function calculateTopicPortfolioStats({ now = runtime.engineNowDate(process.env.ENGINE_NOW).getTime() } = {}) {
  const since = (d) => dtStr(now - d * 86400000);
  const cnt = (rows) => {
    const m = {};
    rows.forEach((r) => { if (r.k) m[r.k] = r.c; });
    return m;
  };
  const q = (sql, p) => my.query(sql, p);
  const NOT_ARCHIVED = "status != 'archived'";
  const [cat7, cat14, cat30, cluster14, cluster30, clusterAll, kw14, recentTitles, recentTopics] = await Promise.all([
    q(`SELECT business_category k, COUNT(*) c FROM articles WHERE ${NOT_ARCHIVED} AND created_at >= ? GROUP BY business_category`, [since(7)]),
    q(`SELECT business_category k, COUNT(*) c FROM articles WHERE ${NOT_ARCHIVED} AND created_at >= ? GROUP BY business_category`, [since(14)]),
    q(`SELECT business_category k, COUNT(*) c FROM articles WHERE ${NOT_ARCHIVED} AND created_at >= ? GROUP BY business_category`, [since(30)]),
    q(`SELECT topic_cluster k, COUNT(*) c FROM articles WHERE ${NOT_ARCHIVED} AND created_at >= ? GROUP BY topic_cluster`, [since(14)]),
    q(`SELECT topic_cluster k, COUNT(*) c FROM articles WHERE ${NOT_ARCHIVED} AND created_at >= ? GROUP BY topic_cluster`, [since(30)]),
    q(`SELECT topic_cluster k, COUNT(*) c FROM articles WHERE ${NOT_ARCHIVED} GROUP BY topic_cluster`),
    q(`SELECT primary_keyword k, COUNT(*) c FROM articles WHERE ${NOT_ARCHIVED} AND created_at >= ? GROUP BY primary_keyword`, [since(14)]),
    q(`SELECT title t FROM articles WHERE ${NOT_ARCHIVED} AND created_at >= ?`, [since(30)]),
    q(`SELECT topic t, normalized_topic n FROM topic_candidates WHERE status IN ('selected','generated') AND created_at >= ?`, [since(30)]),
  ]);
  const stats = {
    now,
    categoryCounts: { d7: cnt(cat7), d14: cnt(cat14), d30: cnt(cat30) },
    clusterCounts: { d14: cnt(cluster14), d30: cnt(cluster30), all: cnt(clusterAll) },
    keywordCounts14d: cnt(kw14),
    recentTitles: recentTitles.map((r) => r.t),
    recentTopics: recentTopics.map((r) => ({ topic: r.t, normalized: r.n })),
    totalArticles14d: cat14.reduce((s, r) => s + r.c, 0),
  };
  return stats;
}

// ---------- 单候选打分 ----------
function calculateSelectionScore(candidate, stats, policy) {
  const pen = policy.penalties || {};
  const bon = policy.bonuses || {};
  const rawScore = candidate.raw_score ?? candidate.score ?? 0;
  const cluster = candidate.topic_cluster || null;
  const category = candidate.business_category || null;
  const penalties = [];
  const bonuses = [];
  let selectionStatus = 'eligible';
  let skipReason = null;

  const deferDays = (policy.defer_policy && policy.defer_policy.default_defer_days) || 14;
  const deferredUntil = new Date(stats.now + deferDays * 86400000).toISOString();

  // 1) 主题簇硬配额（优先级最高：配额拦截 > raw_score）
  if (cluster) {
    const limits = (policy.topic_cluster_limits && (policy.topic_cluster_limits[cluster] || policy.topic_cluster_limits.default)) || { max_articles_14d: 1, max_articles_30d: 2 };
    const c14 = stats.clusterCounts.d14[cluster] || 0;
    const c30 = stats.clusterCounts.d30[cluster] || 0;
    if (c14 >= limits.max_articles_14d) {
      penalties.push({ type: 'topic_cluster_saturation_14d', value: -(pen.topic_cluster_saturation_14d || 40), reason: `topic_cluster ${cluster} 近 14 天已有 ${c14} 篇，上限 ${limits.max_articles_14d}` });
      selectionStatus = 'skipped_quota';
      skipReason = `topic_cluster ${cluster} saturated（14d ${c14}/${limits.max_articles_14d}）`;
    } else if (c30 >= limits.max_articles_30d) {
      penalties.push({ type: 'topic_cluster_saturation_30d', value: -(pen.topic_cluster_saturation_30d || 25), reason: `topic_cluster ${cluster} 近 30 天已有 ${c30} 篇，上限 ${limits.max_articles_30d}` });
      selectionStatus = 'skipped_quota';
      skipReason = `topic_cluster ${cluster} saturated（30d ${c30}/${limits.max_articles_30d}）`;
    }
  }

  // 2) 业务分类硬配额
  if (selectionStatus === 'eligible' && category) {
    const t = (policy.business_category_targets && policy.business_category_targets[category]) || null;
    if (t) {
      const c7 = stats.categoryCounts.d7[category] || 0;
      const c14 = stats.categoryCounts.d14[category] || 0;
      if (c7 >= (t.max_articles_7d ?? 99)) {
        penalties.push({ type: 'business_category_saturation_7d', value: -(pen.business_category_saturation_7d || 25), reason: `business_category ${category} 近 7 天已有 ${c7} 篇，上限 ${t.max_articles_7d}` });
        selectionStatus = 'skipped_quota';
        skipReason = `business_category ${category} saturated（7d ${c7}/${t.max_articles_7d}）`;
      } else if (c14 >= (t.max_articles_14d ?? 99)) {
        penalties.push({ type: 'business_category_saturation_14d', value: -(pen.business_category_saturation_14d || 15), reason: `business_category ${category} 近 14 天已有 ${c14} 篇，上限 ${t.max_articles_14d}` });
        selectionStatus = 'skipped_quota';
        skipReason = `business_category ${category} saturated（14d ${c14}/${t.max_articles_14d}）`;
      }
    }
  }

  // 3) 关键词近期使用（精确匹配，max 2/14d 与 production_policy 对齐）
  const kwCount = candidate.primary_keyword ? (stats.keywordCounts14d[candidate.primary_keyword] || 0) : 0;
  if (kwCount > 0) {
    penalties.push({ type: 'primary_keyword_recent_14d', value: -(pen.primary_keyword_recent_14d || 20), reason: `primary_keyword "${candidate.primary_keyword}" 近 14 天已 ${kwCount} 篇` });
    if (selectionStatus === 'eligible' && kwCount >= 2) {
      selectionStatus = 'skipped_recent_keyword';
      skipReason = `primary_keyword "${candidate.primary_keyword}" 近 14 天已 ${kwCount} 篇（上限 2）`;
    }
  }

  // 4) 相似度：决策委托 topic_dedupe_lib，portfolio 只消费结果并保留 deferred 语义
  const productionPolicy = loadPolicy();
  const td = topicDedupePolicy(productionPolicy);
  const recentForDedupe = [
    ...stats.recentTitles.map((title) => ({ topic: title })),
    ...stats.recentTopics.map((t) => ({ topic: t.topic, normalized_topic: t.normalized })),
  ];
  const similarityDecision = decideTopicDedupe(candidate, recentForDedupe, productionPolicy, { ignoreKeywordThrottle: true });
  const maxTitleSim = findMostSimilar(candidate, stats.recentTitles.map((title) => ({ topic: title }))).similarity;
  const maxTopicSim = findMostSimilar(candidate, stats.recentTopics.map((t) => ({ topic: t.topic, normalized_topic: t.normalized }))).similarity;
  if (maxTitleSim >= td.penalty_similarity_threshold) {
    penalties.push({ type: 'similar_title', value: -(pen.similar_title || 25), reason: `与近 30 天文章标题最高相似度 ${maxTitleSim.toFixed(2)}` });
  }
  if (maxTopicSim >= td.penalty_similarity_threshold) {
    penalties.push({ type: 'similar_normalized_topic', value: -(pen.similar_normalized_topic || 30), reason: `与近 30 天已选/已生成选题最高相似度 ${maxTopicSim.toFixed(2)}` });
  }
  if (selectionStatus === 'eligible' && ['shadow_duplicate', 'deferred_duplicate'].includes(similarityDecision.decision)) {
    selectionStatus = 'skipped_duplicate';
    skipReason = `语义重复（title ${maxTitleSim.toFixed(2)} / topic ${maxTopicSim.toFixed(2)}，${similarityDecision.reason}）`;
  }

  // 5) 组合奖励
  if (category && policy.business_category_targets && policy.business_category_targets[category]) {
    const t = policy.business_category_targets[category];
    const total14 = Math.max(1, stats.totalArticles14d);
    const share = (stats.categoryCounts.d14[category] || 0) / total14;
    if (share < (t.target_share || 0)) {
      bonuses.push({ type: 'underrepresented_business_category', value: bon.underrepresented_business_category || 15, reason: `${category} 近 14 天占比 ${(share * 100).toFixed(0)}% < 目标 ${(t.target_share * 100).toFixed(0)}%` });
      const boostKey = `${category}_boost_if_underrepresented`;
      if (bon[boostKey]) bonuses.push({ type: boostKey, value: bon[boostKey], reason: `${category} 欠代表专项加分` });
    }
  }
  if (cluster && !(stats.clusterCounts.all[cluster] > 0)) {
    bonuses.push({ type: 'first_article_in_topic_cluster', value: bon.first_article_in_topic_cluster || 10, reason: `主题簇 ${cluster} 尚无文章` });
  }
  if (candidate.priority === 'P0') {
    bonuses.push({ type: 'high_business_fit', value: bon.high_business_fit || 8, reason: 'P0 优先级选题' });
  }
  if (candidate.content_type === 'policy_update' || candidate.content_type === 'product_update') {
    bonuses.push({ type: 'fresh_source_policy_update', value: bon.fresh_source_policy_update || 8, reason: `时效型内容（${candidate.content_type}）` });
  }

  // 6) 内容价值门槛（质量优先：SEO/GEO 热度不能替代内容价值）
  const cv = candidate.content_value_score;
  const vb = my.asJson(candidate.value_breakdown_json) || {};
  const VALUE_MIN = 75;
  if (selectionStatus === 'eligible' && cv != null) {
    if (cv < VALUE_MIN) {
      selectionStatus = 'skipped_low_value';
      skipReason = `内容价值分 ${cv} < ${VALUE_MIN}（${vb.reason || '痛点/可执行性/信息增量不足'}）`;
    } else if ((vb.sellerPainValue ?? 99) + (vb.actionability ?? 99) < 22) {
      selectionStatus = 'skipped_low_value';
      skipReason = `痛点(${vb.sellerPainValue})+可执行性(${vb.actionability}) < 22，写出来没用`;
    } else if ((vb.sourceSupport ?? 99) < 4) {
      selectionStatus = 'skipped_low_source_support';
      skipReason = `来源支撑 ${vb.sourceSupport}/10 过低，先 defer 等可核实来源`;
    }
  }

  // 质量优先公式：content_value_score 权重最高，raw_score 降权
  //   selection = cv*0.55 + raw*0.25 + bonuses − penalties
  const cvForScore = cv != null ? cv : Math.round(rawScore * 0.8); // 未评分回退（caller 应先 ensureValueScores）
  const selectionScore = Math.max(0, Math.round(
    cvForScore * 0.55 + rawScore * 0.25
    + penalties.reduce((s, p) => s + p.value, 0) + bonuses.reduce((s, b) => s + b.value, 0)
  ));

  const eligible = selectionStatus === 'eligible';
  // deferred 仅用于「时间窗问题」（饱和/关键词/重复/来源弱）；低价值不是时间问题，保持 candidate
  const deferrable = ['skipped_quota', 'skipped_duplicate', 'skipped_recent_keyword', 'skipped_low_source_support'].includes(selectionStatus);
  return {
    rawScore, contentValueScore: cv, valueBreakdown: vb,
    selectionScore, penalties, bonuses, eligible,
    selectionStatus, skipReason,
    deferredUntil: deferrable ? deferredUntil : null,
    similarity: { title: Number(maxTitleSim.toFixed(3)), topic: Number(maxTopicSim.toFixed(3)) },
  };
}

// ---------- deferred 标记 ----------
async function markCandidateDeferred(candidate, decision, { engineRunId = null } = {}) {
  const now = my.now();
  await my.update('topic_candidates', {
    status: 'deferred',
    raw_score: decision.rawScore,
    selection_score: decision.selectionScore,
    selection_status: decision.selectionStatus,
    selection_skip_reason: decision.skipReason,
    deferred_until: decision.deferredUntil ? decision.deferredUntil.slice(0, 23).replace('T', ' ') : null,
    portfolio_debug_json: { penalties: decision.penalties, bonuses: decision.bonuses, similarity: decision.similarity },
    updated_at: now,
  }, 'id = ?', [candidate.id]);
  await trace.logStatusTransition({ entityType: 'topic_candidate', entityId: candidate.id, engineRunId, fromStatus: candidate.status, toStatus: 'deferred', reason: decision.skipReason });
  await trace.logWorkflowEvent({
    engineRunId, workflowStepId: process.env.WORKFLOW_STEP_ID || null,
    eventType: decision.selectionStatus === 'skipped_duplicate' ? 'topic_candidate_skipped_duplicate' : 'topic_candidate_skipped_quota',
    level: 'info',
    message: `候选 deferred: ${candidate.topic.slice(0, 50)} — ${decision.skipReason}（raw ${decision.rawScore} → selection ${decision.selectionScore}，${decision.deferredUntil ? decision.deferredUntil.slice(0, 10) + ' 后回池' : ''}）`,
    relatedType: 'topic_candidate', relatedId: candidate.id,
    data: { raw_score: decision.rawScore, selection_score: decision.selectionScore, selection_status: decision.selectionStatus },
  });
}

/**
 * 组合选择器主入口。
 * 候选池：candidate/selected + 到期回池的 deferred；按 selection_score 排序；批内 topic_cluster 不重复。
 * @returns {{ selected, deferred, batchSkipped, decisions }}
 */
async function selectTopicCandidates({ limit = 1, minScore = 80, category = null, dryRun = false, engineRunId = null, skipValueScoring = false } = {}) {
  if (!skipValueScoring) await ensureValueScores({ engineRunId }); // 缺价值分的候选先补分（AI 限额 + 启发式兜底）
  const policy = loadContentPortfolioPolicy();
  const stats = await calculateTopicPortfolioStats({});
  const nowStr = my.now();

  let sql = `SELECT * FROM topic_candidates
    WHERE (status IN ('candidate', 'selected') OR (status = 'deferred' AND deferred_until IS NOT NULL AND deferred_until <= ?))
      AND score >= ?
      AND NOT EXISTS (
        SELECT 1 FROM article_jobs aj
        WHERE aj.topic_candidate_id = topic_candidates.id
          AND aj.status IN ('pending', 'running', 'generated')
      )`;
  const params = [nowStr, minScore];
  if (category) { sql += ' AND category = ?'; params.push(category); }
  sql += ' ORDER BY score DESC, created_at DESC LIMIT 80';
  const pool = await my.query(sql, params);

  const decisions = [];
  for (const c of pool) {
    const d = calculateSelectionScore(c, stats, policy);
    decisions.push({ candidate: c, decision: d });
  }

  // eligible 按 selection_score 降序；同分按 raw_score
  const eligible = decisions.filter((x) => x.decision.eligible)
    .sort((a, b) => b.decision.selectionScore - a.decision.selectionScore || b.decision.rawScore - a.decision.rawScore);
  const ineligible = decisions.filter((x) => !x.decision.eligible);

  // 批内多样性：同 topic_cluster / 同 business_category 超出批内余量则跳过（保持 candidate，不 defer）
  const selected = [];
  const batchSkipped = [];
  const batchCluster = {};
  for (const x of eligible) {
    if (selected.length >= Math.max(1, Math.min(50, limit))) break;
    const cl = x.candidate.topic_cluster;
    if (cl && batchCluster[cl]) {
      batchSkipped.push({ ...x, batchReason: `批内已选同主题簇 ${cl}` });
      continue;
    }
    selected.push(x);
    if (cl) batchCluster[cl] = true;
  }

  // 写库（非 dry-run）：选中 → selected；硬拦截 → deferred；其余 eligible 未选中 → 记录评分但保持 candidate
  if (!dryRun) {
    for (const x of selected) {
      await my.update('topic_candidates', {
        status: 'selected', raw_score: x.decision.rawScore, selection_score: x.decision.selectionScore,
        selection_status: 'selected', selection_skip_reason: null, deferred_until: null,
        portfolio_debug_json: { penalties: x.decision.penalties, bonuses: x.decision.bonuses, similarity: x.decision.similarity },
        updated_at: my.now(),
      }, 'id = ?', [x.candidate.id]);
      await trace.logWorkflowEvent({
        engineRunId, workflowStepId: process.env.WORKFLOW_STEP_ID || null,
        eventType: 'topic_candidate_selected', level: 'info',
        message: `组合选中: ${x.candidate.topic.slice(0, 50)}（raw ${x.decision.rawScore} → selection ${x.decision.selectionScore}，${x.candidate.business_category || '-'}/${x.candidate.topic_cluster || '-'}）`,
        relatedType: 'topic_candidate', relatedId: x.candidate.id,
        data: { raw_score: x.decision.rawScore, selection_score: x.decision.selectionScore, bonuses: x.decision.bonuses.length, penalties: x.decision.penalties.length },
      });
    }
    for (const x of ineligible) {
      if (x.decision.deferredUntil) {
        await markCandidateDeferred(x.candidate, x.decision, { engineRunId });
      } else {
        // 低价值：留在 candidate 池但写明原因（不是时间窗问题，不 defer）
        await my.update('topic_candidates', {
          raw_score: x.decision.rawScore, selection_score: x.decision.selectionScore,
          selection_status: x.decision.selectionStatus, selection_skip_reason: x.decision.skipReason,
          portfolio_debug_json: { penalties: x.decision.penalties, bonuses: x.decision.bonuses, similarity: x.decision.similarity, valueBreakdown: x.decision.valueBreakdown },
          updated_at: my.now(),
        }, 'id = ?', [x.candidate.id]);
      }
    }
    for (const x of [...batchSkipped, ...eligible.filter((e) => !selected.includes(e) && !batchSkipped.includes(e))]) {
      // 评分留痕但不改状态（下轮仍可选）
      await my.update('topic_candidates', {
        raw_score: x.decision.rawScore, selection_score: x.decision.selectionScore,
        selection_status: 'eligible',
        portfolio_debug_json: { penalties: x.decision.penalties, bonuses: x.decision.bonuses, similarity: x.decision.similarity },
        updated_at: my.now(),
      }, 'id = ?', [x.candidate.id]);
    }
  }

  return { selected, deferred: ineligible, batchSkipped, decisions, stats, policy };
}

// ---------- 组合健康度报告 ----------
async function getPortfolioHealthReport() {
  const policy = loadContentPortfolioPolicy();
  const stats = await calculateTopicPortfolioStats({});
  const diag = policy.diagnostics || {};

  const dominantClusterWarning = [];
  const total14 = Math.max(1, stats.totalArticles14d);
  for (const [cl, c] of Object.entries(stats.clusterCounts.d14)) {
    const share = c / total14;
    if (share > (diag.warn_if_cluster_share_above || 0.35)) {
      dominantClusterWarning.push(`topic_cluster ${cl} 近 14 天占比 ${(share * 100).toFixed(0)}%（${c}/${total14}，阈值 ${(diag.warn_if_cluster_share_above * 100).toFixed(0)}%）`);
    }
  }
  for (const [cat, c] of Object.entries(stats.categoryCounts.d14)) {
    const share = c / total14;
    if (share > (diag.warn_if_category_share_above || 0.45)) {
      dominantClusterWarning.push(`business_category ${cat} 近 14 天占比 ${(share * 100).toFixed(0)}%（${c}/${total14}，阈值 ${(diag.warn_if_category_share_above * 100).toFixed(0)}%）`);
    }
  }

  const selCounts = Object.fromEntries((await my.query('SELECT selection_status k, COUNT(*) c FROM topic_candidates WHERE selection_status IS NOT NULL GROUP BY selection_status')).map((r) => [r.k, r.c]));
  const deferredActive = (await my.query("SELECT COUNT(*) c FROM topic_candidates WHERE status = 'deferred' AND deferred_until > ?", [my.now()]))[0].c;

  // 关键词库分布告警
  const kwWarnings = [];
  try {
    const kws = await my.query('SELECT cluster, priority FROM config_keywords WHERE enabled = 1');
    const CLUSTER_TO_CAT = clusterCategoryMap();
    const byCat = {};
    const p0ByCat = {};
    for (const k of kws) {
      const cat = CLUSTER_TO_CAT[k.cluster] || 'other';
      byCat[cat] = (byCat[cat] || 0) + 1;
      if (k.priority === 'P0') p0ByCat[cat] = (p0ByCat[cat] || 0) + 1;
    }
    const total = kws.length || 1;
    const aiShare = ((byCat.amazon_ai_shopping || 0) + (byCat.listing_geo || 0)) / total;
    if (aiShare > 0.35) kwWarnings.push(`关键词库 Amazon AI Shopping + Listing GEO 合计占比 ${(aiShare * 100).toFixed(0)}% > 35%`);
    const totalP0 = Object.values(p0ByCat).reduce((s, c) => s + c, 0) || 1;
    for (const [cat, c] of Object.entries(p0ByCat)) {
      if (c / totalP0 > (diag.warn_if_p0_keywords_category_share_above || 0.4)) kwWarnings.push(`P0 关键词 ${(c / totalP0 * 100).toFixed(0)}% 集中在 ${cat}`);
    }
    for (const [cat, min] of [['ppc_acos', 20], ['product_research', 20], ['keyword_intent', 15]]) {
      if ((byCat[cat] || 0) < min) kwWarnings.push(`${cat} 关键词仅 ${byCat[cat] || 0} 个（建议 ≥ ${min}）`);
    }
    for (const cat of ['review_qa', 'account_compliance', 'fba_inventory', 'brand_growth']) {
      if ((byCat[cat] || 0) < 5) kwWarnings.push(`${cat} 关键词仅 ${byCat[cat] || 0} 个（建议 ≥ 5）`);
    }
  } catch (_) { /* config_keywords 不可用时跳过 */ }

  const recommendations = [];
  if (dominantClusterWarning.length) recommendations.push('近期产出集中度过高：组合选择器将自动 defer 饱和簇的高分候选，优先未饱和分类');
  if (kwWarnings.length) recommendations.push('关键词库存在结构性偏置：运行 npm run keywords:analyze 查看明细并调整 config/keywords.csv');
  const missing = ['ppc_acos', 'product_research', 'keyword_intent', 'review_qa', 'account_compliance'].filter((c) => !(stats.categoryCounts.d30[c] > 0));
  if (missing.length) recommendations.push(`近 30 天零产出的业务分类: ${missing.join(' / ')}（候选池需要这些方向的选题，检查关键词库与采集源覆盖）`);

  return {
    recentBusinessCategoryDistribution: { d7: stats.categoryCounts.d7, d14: stats.categoryCounts.d14, d30: stats.categoryCounts.d30 },
    recentTopicClusterDistribution: { d14: stats.clusterCounts.d14, d30: stats.clusterCounts.d30 },
    deferredCandidates: deferredActive,
    quotaSkippedCandidates: selCounts.skipped_quota || 0,
    duplicateSkippedCandidates: selCounts.skipped_duplicate || 0,
    recentKeywordSkippedCandidates: selCounts.skipped_recent_keyword || 0,
    selectionStatusCounts: selCounts,
    dominantClusterWarning,
    keywordDistributionWarnings: kwWarnings,
    recommendations,
  };
}

// ---------- 内容价值补分（存量候选缺 content_value_score 时）----------
// AI 批量评分（topic_value_score prompt）；--no-ai / 超预算时启发式回退（标记 _estimated）。
function heuristicValueScore(candidate, stats) {
  const PAIN_RE = /(acos|封号|申诉|退货|差评|流量下滑|断货|亏|被下架|侵权|仓储费|转化率低|烧钱|suppressed)/i;
  const vb = {
    sellerPainValue: PAIN_RE.test(candidate.topic) ? 16 : candidate.content_type === 'risk_warning' ? 14 : 10,
    actionability: candidate.content_type === 'operation_guide' ? 16 : candidate.content_type === 'qa_discussion' ? 12 : 9,
    informationGain: (my.asJson(candidate.source_urls_json) || []).length >= 2 ? 13 : 9,
    businessFit: candidate.priority === 'P0' ? 12 : candidate.priority === 'P1' ? 10 : 8,
    nonRepetition: 12, // 相似度已由 selection 惩罚单独处理，这里给中性值
    sourceSupport: Math.min(10, (my.asJson(candidate.source_urls_json) || []).length * 3 + 2),
    _estimated: true,
  };
  const maxSim = findMostSimilar(candidate, stats.recentTitles.map((title) => ({ topic: title }))).similarity;
  if (maxSim >= 0.45) vb.nonRepetition = 4;
  else if (maxSim >= 0.3) vb.nonRepetition = 8;
  const total = vb.sellerPainValue + vb.actionability + vb.informationGain + vb.businessFit + vb.nonRepetition + vb.sourceSupport;
  return { total, vb };
}

async function ensureValueScores({ limit = 60, maxAiCalls = 4, noAi = false, engineRunId = null, batchSize = 12 } = {}) {
  const rows = await my.query(
    `SELECT * FROM topic_candidates WHERE content_value_score IS NULL AND status IN ('candidate', 'selected', 'deferred') AND score >= 70 ORDER BY score DESC LIMIT ${Math.min(200, limit)}`);
  if (!rows.length) return { scored: 0, byAi: 0, byHeuristic: 0 };
  const stats = await calculateTopicPortfolioStats({});
  let byAi = 0;
  let byHeuristic = 0;
  let aiCalls = 0;
  let cursor = 0;
  while (cursor < rows.length) {
    const batch = rows.slice(cursor, cursor + batchSize);
    cursor += batch.length;
    let scoresByIdx = new Map();
    if (!noAi && aiCalls < maxAiCalls) {
      aiCalls++;
      try {
        const { callAgent } = require('./pipeline_lib');
        const prompts = require('./prompt_lib');
        const r = await callAgent({
          taskType: 'topic_value_score',
          prompt: prompts.valueScorePrompt({
            items: batch.map((c, i) => ({
              index: i + 1, topic: c.topic, contentAngle: c.content_angle, businessAngle: c.business_angle,
              primaryKeyword: c.primary_keyword, sourceUrlCount: (my.asJson(c.source_urls_json) || []).length,
            })),
            recentTopics: stats.recentTitles,
          }),
          sessionKey: `agent:main:valuescore-${Date.now() % 1e6}`,
          engineRunId, timeoutSec: 600,
        });
        if (r.ok && Array.isArray(r.data)) {
          for (const it of r.data) {
            if (it && typeof it.index === 'number' && typeof it.contentValueScore === 'number') scoresByIdx.set(it.index, it);
          }
        }
      } catch (_) { /* AI 失败走启发式 */ }
    }
    const now = my.now();
    for (let i = 0; i < batch.length; i++) {
      const c = batch[i];
      const ai = scoresByIdx.get(i + 1);
      if (ai) {
        await my.update('topic_candidates', {
          content_value_score: Math.round(ai.contentValueScore),
          value_breakdown_json: {
            sellerPainValue: ai.sellerPainValue, actionability: ai.actionability, informationGain: ai.informationGain,
            businessFit: ai.businessFit, nonRepetition: ai.nonRepetition, sourceSupport: ai.sourceSupport, reason: ai.reason,
          },
          updated_at: now,
        }, 'id = ?', [c.id]);
        byAi++;
      } else {
        const h = heuristicValueScore(c, stats);
        await my.update('topic_candidates', {
          content_value_score: h.total, value_breakdown_json: h.vb, updated_at: now,
        }, 'id = ?', [c.id]);
        byHeuristic++;
      }
    }
  }
  await trace.logWorkflowEvent({
    engineRunId, eventType: 'topic_value_scored', level: 'info',
    message: `候选价值评分完成: ${byAi + byHeuristic} 条（AI ${byAi} / 启发式 ${byHeuristic}）`,
    relatedType: 'topic_candidate',
  });
  return { scored: byAi + byHeuristic, byAi, byHeuristic };
}

// 关键词 cluster → business_category 推断映射（keywords:analyze 共用）
function clusterCategoryMap() {
  return {
    'alexa-shopping': 'amazon_ai_shopping', 'amazon-rufus': 'amazon_ai_shopping', 'ai-search-era': 'amazon_ai_shopping',
    'listing-optimization': 'listing_geo', 'amazon-geo': 'listing_geo', 'cosmo-algorithm': 'listing_geo',
    'amazon-ppc': 'ppc_acos', 'ppc-acos': 'ppc_acos',
    'product-research': 'product_research', 'product-opportunity': 'product_research',
    'keyword-research': 'keyword_intent', 'keyword-intent': 'keyword_intent',
    'review-qa': 'review_qa', 'account-compliance': 'account_compliance',
    'fba-logistics': 'fba_inventory', 'brand-growth': 'brand_growth', 'ai-tools': 'ai_tools',
    'traffic-decline': 'listing_geo', 'marketplace-policy': 'marketplace_policy',
  };
}

module.exports = {
  loadContentPortfolioPolicy, calculateTopicPortfolioStats, calculateSelectionScore,
  selectTopicCandidates, markCandidateDeferred, getPortfolioHealthReport, clusterCategoryMap,
  ensureValueScores, heuristicValueScore,
};
