#!/usr/bin/env node
// topic_audition.js — 选题压力测试（Phase 12D）：模拟未来 N 轮选题，不生成文章。
// 回答：接下来会写什么？有没有用？有没有重复？分类是否均衡？哪些缺口？能不能开始生成？
// 用法:
//   npm run topic:audition -- --rounds 10 --limit 3
//   npm run topic:audition -- --rounds 20 --limit 1
//   npm run topic:audition -- --rounds 10 --limit 3 --json
//   npm run topic:audition -- --rounds 10 --limit 3 --refresh-candidates   # 先重跑选题生成（不生成文章）
const my = require('../lib/mysql_lib');
const { jaccard } = require('../lib/production_policy_lib');

function parseArgs(argv) {
  const args = { rounds: 10, limit: 1, json: false, refresh: false, noAi: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--rounds') args.rounds = Math.max(1, Math.min(60, parseInt(argv[++i], 10) || 10));
    else if (argv[i] === '--limit') args.limit = Math.max(1, Math.min(5, parseInt(argv[++i], 10) || 1));
    else if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--refresh-candidates') args.refresh = true;
    else if (argv[i] === '--no-ai') args.noAi = true;
  }
  return args;
}

const DAY = 86400000;

// 模拟时刻的组合统计：真实文章按窗口滑动 + 模拟已选累积
function buildSimStats({ simNow, realArticles, simSelections }) {
  const winCount = (col, days) => {
    const m = {};
    const since = simNow - days * DAY;
    for (const a of realArticles) if (a.ts > since && a.ts <= simNow && a[col]) m[a[col]] = (m[a[col]] || 0) + 1;
    for (const s of simSelections) if (s.ts > since && s.ts <= simNow && s[col]) m[s[col]] = (m[s[col]] || 0) + 1;
    return m;
  };
  const titles = [];
  const topics = [];
  const since30 = simNow - 30 * DAY;
  for (const a of realArticles) if (a.ts > since30 && a.ts <= simNow) titles.push(a.title);
  for (const s of simSelections) if (s.ts > since30 && s.ts <= simNow) { titles.push(s.topic); topics.push({ topic: s.topic, normalized: s.normalized }); }
  const allCluster = {};
  for (const a of realArticles) if (a.cluster) allCluster[a.cluster] = (allCluster[a.cluster] || 0) + 1;
  for (const s of simSelections) if (s.cluster) allCluster[s.cluster] = (allCluster[s.cluster] || 0) + 1;
  const cat14 = winCount('category', 14);
  return {
    now: simNow,
    categoryCounts: { d7: winCount('category', 7), d14: cat14, d30: winCount('category', 30) },
    clusterCounts: { d14: winCount('cluster', 14), d30: winCount('cluster', 30), all: allCluster },
    keywordCounts14d: winCount('keyword', 14),
    recentTitles: titles,
    recentTopics: topics,
    totalArticles14d: Object.values(cat14).reduce((s, c) => s + c, 0),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const engineRunId = process.env.ENGINE_RUN_ID || null;
  try {
    await require('../lib/config_lib').ensureInit();
    const portfolio = require('../lib/topic_portfolio_lib');

    // 0) 可选：刷新候选池（重跑选题生成，不生成文章）
    let refreshInfo = null;
    if (args.refresh) {
      const { generateTopics } = require('../lib/pipeline_lib');
      const r = await generateTopics({ engineRunId });
      refreshInfo = r.ok ? { inserted: r.inserted, duplicates: r.duplicates, dedupeRejected: r.dedupeRejected } : { error: r.error };
    }
    // 0.5) 缺价值分的候选先补分
    const valueScoring = await portfolio.ensureValueScores({ engineRunId, noAi: args.noAi });

    const policy = portfolio.loadContentPortfolioPolicy();
    const minScore = policy.selection_policy ? (policy.selection_policy.raw_score_min || 80) : 80;

    // 1) 基础数据
    const realArticles = (await my.query("SELECT title, business_category category, topic_cluster cluster, primary_keyword keyword, created_at FROM articles WHERE status != 'archived' AND created_at >= DATE_SUB(NOW(3), INTERVAL 90 DAY)"))
      .map((a) => ({ ...a, ts: new Date(a.created_at).getTime() }));
    const pool = await my.query(
      `SELECT * FROM topic_candidates WHERE status IN ('candidate', 'selected', 'deferred') AND score >= ? ORDER BY score DESC LIMIT 120`, [minScore]);

    // 2) 模拟 N 轮（每轮 = 1 天）
    const now = Date.now();
    const simSelections = [];           // { ts, topic, normalized, category, cluster, keyword }
    const simDeferredUntil = new Map(); // candidateId → ts
    const pickedIds = new Set();
    const roundsOut = [];
    const itemRows = [];
    const auditionId = my.makeId('audition');

    for (let round = 1; round <= args.rounds; round++) {
      const simNow = now + (round - 1) * DAY;
      const stats = buildSimStats({ simNow, realArticles, simSelections });
      // 本轮可选：未被模拟选中；DB deferred 未到期或模拟 deferred 未到期的排除
      const eligible = pool.filter((c) => {
        if (pickedIds.has(c.id)) return false;
        const simUntil = simDeferredUntil.get(c.id);
        if (simUntil && simNow < simUntil) return false;
        if (!simUntil && c.status === 'deferred' && c.deferred_until && simNow < new Date(c.deferred_until).getTime()) return false;
        return true;
      });

      const decisions = eligible.map((c) => ({ candidate: c, decision: portfolio.calculateSelectionScore(c, stats, policy) }));
      const ok = decisions.filter((x) => x.decision.eligible)
        .sort((a, b) => b.decision.selectionScore - a.decision.selectionScore || b.decision.rawScore - a.decision.rawScore);

      const picks = [];
      const batchCluster = {};
      for (const x of ok) {
        if (picks.length >= args.limit) break;
        const cl = x.candidate.topic_cluster;
        if (cl && batchCluster[cl]) continue;
        picks.push(x);
        if (cl) batchCluster[cl] = true;
      }

      // 记录本轮：选中 + 新被 defer 的（去重）
      for (const x of picks) {
        pickedIds.add(x.candidate.id);
        simSelections.push({
          ts: simNow, topic: x.candidate.topic,
          normalized: x.candidate.normalized_topic || x.candidate.topic.replace(/\s+/g, ''),
          category: x.candidate.business_category, cluster: x.candidate.topic_cluster, keyword: x.candidate.primary_keyword,
        });
        itemRows.push({ round, c: x.candidate, d: x.decision, decision: 'selected' });
      }
      for (const x of decisions) {
        if (x.decision.eligible) continue;
        if (x.decision.deferredUntil && !simDeferredUntil.has(x.candidate.id)) {
          simDeferredUntil.set(x.candidate.id, simNow + ((policy.defer_policy && policy.defer_policy.default_defer_days) || 14) * DAY);
          itemRows.push({ round, c: x.candidate, d: x.decision, decision: 'deferred' });
        } else if (!x.decision.deferredUntil && round === 1) {
          // 低价值/低来源支撑：只在第 1 轮记录一次快照
          itemRows.push({ round, c: x.candidate, d: x.decision, decision: x.decision.selectionStatus });
        }
      }

      roundsOut.push({
        round,
        date: new Date(simNow).toISOString().slice(0, 10),
        picks: picks.map((x) => ({
          topic: x.candidate.topic, businessCategory: x.candidate.business_category,
          topicCluster: x.candidate.topic_cluster, contentType: x.candidate.content_type,
          primaryKeyword: x.candidate.primary_keyword,
          rawScore: x.decision.rawScore, contentValueScore: x.decision.contentValueScore,
          selectionScore: x.decision.selectionScore,
          valueBreakdown: x.decision.valueBreakdown,
        })),
        poolLeft: eligible.length - picks.length,
      });
    }

    // 3) 汇总
    const allPicks = roundsOut.flatMap((r) => r.picks);
    const dist = (key) => {
      const m = {};
      allPicks.forEach((p) => { const k = p[key] || 'null'; m[k] = (m[k] || 0) + 1; });
      return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]));
    };
    const catDist = dist('businessCategory');
    const clusterDist = dist('topicCluster');
    const typeDist = dist('contentType');
    const avg = (arr) => (arr.length ? Math.round(arr.reduce((s, v) => s + (v || 0), 0) / arr.length * 10) / 10 : null);
    const avgValue = avg(allPicks.map((p) => p.contentValueScore));
    const avgPain = avg(allPicks.map((p) => p.valueBreakdown && p.valueBreakdown.sellerPainValue));
    const avgAction = avg(allPicks.map((p) => p.valueBreakdown && p.valueBreakdown.actionability));

    // 重复风险：选中主题两两相似度
    let maxPair = 0;
    const similarPairs = [];
    for (let i = 0; i < allPicks.length; i++) {
      for (let j = i + 1; j < allPicks.length; j++) {
        const sim = jaccard(allPicks[i].topic, allPicks[j].topic);
        if (sim > maxPair) maxPair = sim;
        if (sim >= 0.35) similarPairs.push({ a: allPicks[i].topic.slice(0, 40), b: allPicks[j].topic.slice(0, 40), sim: Number(sim.toFixed(2)) });
      }
    }
    const repetitionRisk = maxPair >= 0.45 ? 'high' : maxPair >= 0.3 ? 'medium' : 'low';

    // Alexa/Listing 占比（验收：≤35%）
    const aiCount = (catDist.amazon_ai_shopping || 0) + (catDist.listing_geo || 0);
    const aiShare = allPicks.length ? aiCount / allPicks.length : 0;

    // 分类缺口分析
    const gapAnalysis = [];
    const targetCats = Object.keys((policy.business_category_targets || {}));
    for (const cat of targetCats) {
      if (catDist[cat]) continue;
      const inPool = pool.filter((c) => c.business_category === cat);
      if (!inPool.length) gapAnalysis.push(`${cat}: 候选池为 0 —— 关键词/采集源未产出该方向候选`);
      else {
        const okValue = inPool.filter((c) => (c.content_value_score || 0) >= 75);
        if (!okValue.length) gapAnalysis.push(`${cat}: 有 ${inPool.length} 个候选但内容价值分均 < 75 —— 候选质量不足`);
        else gapAnalysis.push(`${cat}: 有 ${okValue.length} 个合格候选但分数竞争不过其他分类 —— 可考虑提高该分类 underrepresented bonus`);
      }
    }

    // 高分被 defer 列表
    const deferredHigh = itemRows.filter((r) => r.decision === 'deferred' && (r.c.raw_score || r.c.score) >= 88)
      .map((r) => ({ topic: r.c.topic.slice(0, 50), raw: r.d.rawScore, value: r.d.contentValueScore, selection: r.d.selectionScore, reason: r.d.skipReason }));

    const recommendations = [];
    if (aiShare > 0.35) recommendations.push(`Alexa/Listing 合计占比 ${(aiShare * 100).toFixed(0)}% 超 35%：降低其 bonus 或收紧 cluster 配额`);
    if (gapAnalysis.length) recommendations.push(...gapAnalysis.map((g) => `补缺口 → ${g}`));
    if (avgValue != null && avgValue < 80) recommendations.push(`选中主题平均内容价值 ${avgValue} < 80：建议 --refresh-candidates 重新生成候选或提高 VALUE_MIN`);
    if (repetitionRisk !== 'low') recommendations.push(`重复风险 ${repetitionRisk}：检查 similarTopics 列表，必要时手动 defer`);
    const readyVerdict = aiShare <= 0.35 && Object.keys(catDist).length >= 5 && (avgValue || 0) >= 80 && repetitionRisk === 'low'
      ? '✅ 可以开始真实生成文章（选题多样、有用、不重复）'
      : '⚠️ 建议先解决上述问题再批量生成';
    if (!recommendations.length) recommendations.push('选题组合健康，无需调整');

    const summary = {
      rounds: args.rounds, limitPerRound: args.limit, totalSelected: allPicks.length,
      refreshInfo, valueScoring,
      businessCategoryDistribution: catDist, topicClusterDistribution: clusterDist, contentTypeDistribution: typeDist,
      categoriesCovered: Object.keys(catDist).length,
      alexaListingShare: Number((aiShare * 100).toFixed(1)) + '%',
      avgContentValueScore: avgValue, avgSellerPainValue: avgPain, avgActionability: avgAction,
      repetitionRisk, similarTopics: similarPairs.slice(0, 6),
      deferredHighScore: deferredHigh.slice(0, 8),
      gapAnalysis, recommendations, readyVerdict,
    };

    // 4) 写库
    const nowStr = my.now();
    await my.insert('topic_audition_runs', {
      id: auditionId, engine_run_id: engineRunId, rounds: args.rounds, limit_per_round: args.limit,
      policy_json: { selection_policy: policy.selection_policy, defer_policy: policy.defer_policy },
      summary_json: { ...summary, days: roundsOut.map((r) => ({ round: r.round, date: r.date, picks: r.picks.map((p) => ({ topic: p.topic.slice(0, 80), businessCategory: p.businessCategory, contentValueScore: p.contentValueScore })) })) },
      status: 'completed', created_at: nowStr,
    });
    for (const r of itemRows) {
      await my.insert('topic_audition_items', {
        id: my.makeId('audit'), audition_run_id: auditionId, round_no: r.round,
        topic_candidate_id: r.c.id, topic: r.c.topic.slice(0, 510),
        content_type: r.c.content_type, business_category: r.c.business_category, topic_cluster: r.c.topic_cluster,
        primary_keyword: r.c.primary_keyword,
        raw_score: r.d.rawScore, content_value_score: r.d.contentValueScore, selection_score: r.d.selectionScore,
        decision: r.decision, decision_reason: r.d.skipReason || (r.decision === 'selected' ? `组合选中（selection ${r.d.selectionScore}）` : null),
        portfolio_debug_json: { penalties: r.d.penalties, bonuses: r.d.bonuses, valueBreakdown: r.d.valueBreakdown },
        created_at: nowStr,
      });
    }

    // 5) 输出
    if (args.json) {
      console.log(JSON.stringify({ ok: true, auditionId, summary, days: roundsOut }, null, 2));
      return;
    }
    const lines = [];
    lines.push(`\n══════ Topic Audition ${auditionId}（${args.rounds} 轮 × ${args.limit} 篇/轮）══════\n`);
    lines.push('【未来选题日历】');
    for (const r of roundsOut) {
      if (!r.picks.length) { lines.push(`Day ${String(r.round).padStart(2)}: （无可选候选 — 池子耗尽或全部饱和）`); continue; }
      for (const p of r.picks) {
        lines.push(`Day ${String(r.round).padStart(2)}: [${p.businessCategory || '?'}] ${p.topic.slice(0, 52)}`);
        lines.push(`        raw ${p.rawScore} · 价值 ${p.contentValueScore ?? '-'} · 选择分 ${p.selectionScore}${p.valueBreakdown ? ` · 痛点 ${p.valueBreakdown.sellerPainValue}/20 可执行 ${p.valueBreakdown.actionability}/20` : ''}`);
      }
    }
    lines.push('\n【分布】');
    lines.push(`业务分类: ${Object.entries(catDist).map(([k, c]) => `${k} ${c}`).join(' · ')}`);
    lines.push(`主题簇:   ${Object.entries(clusterDist).map(([k, c]) => `${k} ${c}`).join(' · ')}`);
    lines.push(`内容类型: ${Object.entries(typeDist).map(([k, c]) => `${k} ${c}`).join(' · ')}`);
    lines.push(`\n【健康度】覆盖 ${summary.categoriesCovered} 个分类 | Alexa/Listing 占比 ${summary.alexaListingShare} | 平均价值分 ${avgValue}（痛点 ${avgPain}/20 · 可执行 ${avgAction}/20）| 重复风险 ${repetitionRisk}`);
    if (similarPairs.length) lines.push(`相似对: ${similarPairs.map((s) => `「${s.a}」vs「${s.b}」${s.sim}`).join('；')}`);
    if (deferredHigh.length) {
      lines.push('\n【被延期的高分主题】');
      deferredHigh.slice(0, 5).forEach((d) => lines.push(`  raw ${d.raw} / 价值 ${d.value ?? '-'} / 选择分 ${d.selection} — ${d.topic} ｜ ${d.reason}`));
    }
    if (gapAnalysis.length) {
      lines.push('\n【分类缺口】');
      gapAnalysis.forEach((g) => lines.push(`  · ${g}`));
    }
    lines.push('\n【建议】');
    recommendations.forEach((r, i) => lines.push(`  ${i + 1}. ${r}`));
    lines.push(`\n【结论】${readyVerdict}`);
    lines.push(`\n（明细已写入 topic_audition_runs/${auditionId} + topic_audition_items，Viewer 选题池页可见）`);
    console.log(lines.join('\n'));
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
    process.exitCode = 1;
  } finally {
    await my.closePool();
  }
}

main();
