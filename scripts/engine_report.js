#!/usr/bin/env node
// engine_report.js — 生产报告写入 engine_reports 表（DB-only），CLI 打印摘要
// 用法: npm run engine:report [-- --run-id <id>] [--since 2026-06-01]
const my = require('./lib/mysql_lib');

const REQUIRED_CHANNELS = ['wechat', 'douyin', 'xiaohongshu'];

function parseArgs(argv) {
  const args = { runId: null, since: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--run-id') args.runId = argv[++i];
    else if (argv[i] === '--since') args.since = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  try {
    const engineRuns = args.runId
      ? await my.query('SELECT * FROM engine_runs WHERE id = ?', [args.runId])
      : args.since
        ? await my.query('SELECT * FROM engine_runs WHERE started_at >= ? ORDER BY started_at DESC', [`${args.since} 00:00:00`])
        : await my.query('SELECT * FROM engine_runs ORDER BY started_at DESC LIMIT 10');

    const statusCounts = Object.fromEntries((await my.query('SELECT status, COUNT(*) c FROM articles GROUP BY status ORDER BY c DESC')).map((r) => [r.status, r.c]));
    const readyForReview = await my.query("SELECT id, title, slug, quality_score, seo_score, geo_score, fact_publish_readiness FROM articles WHERE status = 'ready_for_review' ORDER BY created_at DESC");
    const needsFactSources = await my.query("SELECT id, title, slug, quality_score FROM articles WHERE status = 'needs_fact_sources' ORDER BY created_at DESC");
    const recentArticles = await my.query('SELECT id, title, status, quality_score, created_at FROM articles ORDER BY created_at DESC LIMIT 10');
    const failedModelRuns = (await my.query("SELECT task_type, error_message, started_at FROM model_runs WHERE status = 'failed' ORDER BY started_at DESC LIMIT 20")).map((r) => ({ taskType: r.task_type, startedAt: String(r.started_at), error: (r.error_message || '').slice(0, 160) }));
    const packages = await my.query('SELECT slug, status, ready_for_publish_package, updated_at FROM publish_packages ORDER BY updated_at DESC LIMIT 20');

    // 渠道覆盖率
    const reviewables = await my.query("SELECT id FROM articles WHERE status IN ('ready_for_review','reviewed','approved_for_publish')");
    let completeChannelSet = 0;
    const missingChannelsList = [];
    for (const a of reviewables) {
      const chs = (await my.query('SELECT channel FROM channel_outputs WHERE article_id = ?', [a.id])).map((c) => c.channel);
      const missing = REQUIRED_CHANNELS.filter((ch) => !chs.includes(ch));
      if (missing.length === 0) completeChannelSet++;
      else missingChannelsList.push({ articleId: a.id, missing });
    }

    // SEO/GEO 汇总
    const scored = await my.query(`
      SELECT a.id, a.title, s.seo_score, s.geo_score, s.overall_score, s.strategy, s.recommendation
      FROM articles a JOIN seo_geo_scores s ON s.id = (SELECT id FROM seo_geo_scores WHERE article_id = a.id ORDER BY created_at DESC LIMIT 1)`);
    const avg = (arr) => (arr.length ? Math.round(arr.reduce((x, y) => x + y, 0) / arr.length) : null);
    const seoGeoSummary = {
      scoredArticles: scored.length,
      avgSeoScore: avg(scored.map((s) => s.seo_score)),
      avgGeoScore: avg(scored.map((s) => s.geo_score)),
      avgOverallScore: avg(scored.map((s) => s.overall_score)),
      perArticle: scored.map((s) => ({ articleId: s.id, title: s.title.slice(0, 40), seo: s.seo_score, geo: s.geo_score, overall: s.overall_score, strategy: s.strategy, recommendation: s.recommendation })),
    };

    // 内容分类统计（content_type / business_category / topic_cluster）
    const cnt = (rows) => Object.fromEntries(rows.filter((r) => r.k).map((r) => [r.k, r.c]));
    const contentTypeCounts = cnt(await my.query('SELECT content_type k, COUNT(*) c FROM articles GROUP BY content_type ORDER BY c DESC'));
    const businessCategoryCounts = cnt(await my.query('SELECT business_category k, COUNT(*) c FROM articles GROUP BY business_category ORDER BY c DESC'));
    const topicClusterCounts = cnt(await my.query('SELECT topic_cluster k, COUNT(*) c FROM articles GROUP BY topic_cluster ORDER BY c DESC'));
    // source 多但文章少的业务分类（近 7 天 source vs 全部文章）
    const srcCatCounts = cnt(await my.query("SELECT business_category k, COUNT(*) c FROM source_items WHERE created_at >= DATE_SUB(NOW(3), INTERVAL 7 DAY) GROUP BY business_category ORDER BY c DESC"));
    const underproducedCategories = Object.entries(srcCatCounts)
      .filter(([k, c]) => c >= 10 && (businessCategoryCounts[k] || 0) <= 1)
      .map(([k, c]) => ({ businessCategory: k, sourceItems7d: c, articles: businessCategoryCounts[k] || 0 }));
    // 各业务分类积压 needs_fact_sources
    const backlogByCategory = cnt(await my.query("SELECT business_category k, COUNT(*) c FROM articles WHERE status = 'needs_fact_sources' GROUP BY business_category"));
    const unclassified = {
      sourceItems: (await my.query('SELECT COUNT(*) c FROM source_items WHERE content_type IS NULL'))[0].c,
      topicCandidates: (await my.query('SELECT COUNT(*) c FROM topic_candidates WHERE content_type IS NULL'))[0].c,
      articles: (await my.query('SELECT COUNT(*) c FROM articles WHERE content_type IS NULL'))[0].c,
    };
    const taxonomySummary = { contentTypeCounts, businessCategoryCounts, topicClusterCounts, sourceItemsByCategory7d: srcCatCounts, underproducedCategories, backlogByCategory, unclassified };

    // trace 健康度：最近 24h 的 trace 事件量 + 最近 run 是否有 trace 缺失迹象
    const traceHealth = (await my.query("SELECT (SELECT COUNT(*) FROM workflow_steps WHERE created_at >= DATE_SUB(NOW(3), INTERVAL 1 DAY)) steps, (SELECT COUNT(*) FROM workflow_events WHERE created_at >= DATE_SUB(NOW(3), INTERVAL 1 DAY)) events, (SELECT COUNT(*) FROM workflow_events WHERE level='error' AND created_at >= DATE_SUB(NOW(3), INTERVAL 1 DAY)) errorEvents"))[0];

    const nextActions = [];
    if (engineRuns[0] && my.asJson(engineRuns[0].summary_json) && my.asJson(engineRuns[0].summary_json).traceFailures > 0) {
      nextActions.push(`⚠️ 最近一次 engine run 有 ${my.asJson(engineRuns[0].summary_json).traceFailures} 次 trace 写入失败，检查 workflow_* 表`);
    }
    if (needsFactSources.length) nextActions.push(`${needsFactSources.length} 篇待补来源: npm run sources:fix -- --limit ${needsFactSources.length}`);
    if (unclassified.sourceItems + unclassified.topicCandidates + unclassified.articles > 0) nextActions.push(`${unclassified.sourceItems + unclassified.topicCandidates + unclassified.articles} 条内容未分类: npm run content:classify -- --all --limit 500`);
    if (missingChannelsList.length) nextActions.push(`${missingChannelsList.length} 篇缺渠道: npm run channels:generate -- --status ready_for_review --missing-only`);
    if (readyForReview.length) nextActions.push(`${readyForReview.length} 篇待终审: npm run review:mark -- --article-id <id> --status approved_for_publish`);
    if (!nextActions.length) nextActions.push('流水线无积压，可运行 npm run engine:daily');

    const report = {
      ok: true, generatedAt: new Date().toISOString(), filters: args,
      engineRuns: engineRuns.map((r) => ({ id: r.id, type: r.run_type, status: r.status, startedAt: String(r.started_at), topicsCollected: r.topics_collected, topicsSelected: r.topics_selected, articlesGenerated: r.articles_generated, factChecksCompleted: r.fact_checks_completed, channelOutputsGenerated: r.channel_outputs_generated })),
      statusCounts, recentArticles: recentArticles.map((a) => ({ ...a, created_at: String(a.created_at) })), readyForReview, needsFactSources,
      channelCoverage: { totalReadyArticles: reviewables.length, completeChannelSet, missingChannels: missingChannelsList },
      seoGeoSummary, failedModelRuns, traceHealth,
      contentTypeCounts, businessCategoryCounts, topicClusterCounts, taxonomySummary,
      packages: packages.map((p) => ({ slug: p.slug, status: p.status, ready: !!p.ready_for_publish_package })),
      nextActions,
    };

    const md = `# Flyfus 内容引擎生产报告

> ${report.generatedAt}

## 状态分布

${Object.entries(statusCounts).map(([s, c]) => `- **${s}**: ${c}`).join('\n') || '-'}

## 待终审（${readyForReview.length}）

${readyForReview.map((a) => `- ${a.title}（质量 ${a.quality_score} / SEO ${a.seo_score ?? '-'} / GEO ${a.geo_score ?? '-'}）\`${a.id}\``).join('\n') || '- 无'}

## SEO/GEO

平均 SEO ${seoGeoSummary.avgSeoScore ?? '-'} / GEO ${seoGeoSummary.avgGeoScore ?? '-'} / 综合 ${seoGeoSummary.avgOverallScore ?? '-'}（${seoGeoSummary.scoredArticles} 篇已评分）

## 内容分类

**内容类型**: ${Object.entries(contentTypeCounts).map(([k, c]) => `${k} ${c}`).join(' · ') || '（全部未分类）'}

**业务分类**: ${Object.entries(businessCategoryCounts).map(([k, c]) => `${k} ${c}`).join(' · ') || '（全部未分类）'}

**主题簇**: ${Object.entries(topicClusterCounts).map(([k, c]) => `${k} ${c}`).join(' · ') || '（无）'}

${underproducedCategories.length ? `**source 多但文章少**：${underproducedCategories.map((u) => `${u.businessCategory}（近 7 天 source ${u.sourceItems7d} 条 / 文章 ${u.articles} 篇）`).join('；')}` : '**source 多但文章少**：无明显缺口'}

${Object.keys(backlogByCategory).length ? `**待补来源积压（按业务分类）**：${Object.entries(backlogByCategory).map(([k, c]) => `${k} ${c} 篇`).join('；')}` : ''}

${unclassified.sourceItems + unclassified.topicCandidates + unclassified.articles > 0 ? `> ⚠️ 未分类：source_items ${unclassified.sourceItems} / topic_candidates ${unclassified.topicCandidates} / articles ${unclassified.articles}，运行 \`npm run content:classify -- --all\`` : ''}

## 渠道覆盖

${reviewables.length} 篇可终审，${completeChannelSet} 篇渠道齐全

## 发布包（${packages.length}）

${packages.map((p) => `- ${p.slug} — ${p.status}${p.ready_for_publish_package ? ' ✅' : ''}`).join('\n') || '- 无'}

## 下一步

${nextActions.map((a, i) => `${i + 1}. ${a}`).join('\n')}
`;

    const id = my.makeId('report');
    await my.insert('engine_reports', { id, engine_run_id: args.runId || null, report_json: report, report_markdown: md, created_at: my.now() });

    console.log(JSON.stringify({ ok: true, reportId: id, storedIn: 'engine_reports (MySQL)', statusCounts, contentTypeCounts, businessCategoryCounts, topicClusterCounts, readyForReview: readyForReview.length, needsFactSources: needsFactSources.length, channelCoverage: report.channelCoverage, seoGeoSummary: { avgSeo: seoGeoSummary.avgSeoScore, avgGeo: seoGeoSummary.avgGeoScore, scored: seoGeoSummary.scoredArticles }, nextActions }, null, 2));
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
    process.exitCode = 1;
  } finally {
    await my.closePool();
  }
}

main();
