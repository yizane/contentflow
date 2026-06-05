#!/usr/bin/env node
// engine_report.js — 生产报告写入 engine_reports 表（DB-only），CLI 打印摘要
// 用法: npm run engine:report [-- --run-id <id>] [--since 2026-06-01]
const my = require('./mysql_lib');

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

    // trace 健康度：最近 24h 的 trace 事件量 + 最近 run 是否有 trace 缺失迹象
    const traceHealth = (await my.query("SELECT (SELECT COUNT(*) FROM workflow_steps WHERE created_at >= DATE_SUB(NOW(3), INTERVAL 1 DAY)) steps, (SELECT COUNT(*) FROM workflow_events WHERE created_at >= DATE_SUB(NOW(3), INTERVAL 1 DAY)) events, (SELECT COUNT(*) FROM workflow_events WHERE level='error' AND created_at >= DATE_SUB(NOW(3), INTERVAL 1 DAY)) errorEvents"))[0];

    const nextActions = [];
    if (engineRuns[0] && my.asJson(engineRuns[0].summary_json) && my.asJson(engineRuns[0].summary_json).traceFailures > 0) {
      nextActions.push(`⚠️ 最近一次 engine run 有 ${my.asJson(engineRuns[0].summary_json).traceFailures} 次 trace 写入失败，检查 workflow_* 表`);
    }
    if (needsFactSources.length) nextActions.push(`${needsFactSources.length} 篇待补来源: npm run fix:sources -- --limit ${needsFactSources.length}`);
    if (missingChannelsList.length) nextActions.push(`${missingChannelsList.length} 篇缺渠道: npm run channels:generate -- --status ready_for_review --missing-only`);
    if (readyForReview.length) nextActions.push(`${readyForReview.length} 篇待终审: npm run review:mark -- --article-id <id> --status approved_for_publish`);
    if (!nextActions.length) nextActions.push('流水线无积压，可运行 npm run engine:daily');

    const report = {
      ok: true, generatedAt: new Date().toISOString(), filters: args,
      engineRuns: engineRuns.map((r) => ({ id: r.id, type: r.run_type, status: r.status, startedAt: String(r.started_at), topicsCollected: r.topics_collected, topicsSelected: r.topics_selected, articlesGenerated: r.articles_generated, factChecksCompleted: r.fact_checks_completed, channelOutputsGenerated: r.channel_outputs_generated })),
      statusCounts, recentArticles: recentArticles.map((a) => ({ ...a, created_at: String(a.created_at) })), readyForReview, needsFactSources,
      channelCoverage: { totalReadyArticles: reviewables.length, completeChannelSet, missingChannels: missingChannelsList },
      seoGeoSummary, failedModelRuns, traceHealth,
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

## 渠道覆盖

${reviewables.length} 篇可终审，${completeChannelSet} 篇渠道齐全

## 发布包（${packages.length}）

${packages.map((p) => `- ${p.slug} — ${p.status}${p.ready_for_publish_package ? ' ✅' : ''}`).join('\n') || '- 无'}

## 下一步

${nextActions.map((a, i) => `${i + 1}. ${a}`).join('\n')}
`;

    const id = my.makeId('report');
    await my.insert('engine_reports', { id, engine_run_id: args.runId || null, report_json: report, report_markdown: md, created_at: my.now() });

    console.log(JSON.stringify({ ok: true, reportId: id, storedIn: 'engine_reports (MySQL)', statusCounts, readyForReview: readyForReview.length, needsFactSources: needsFactSources.length, channelCoverage: report.channelCoverage, seoGeoSummary: { avgSeo: seoGeoSummary.avgSeoScore, avgGeo: seoGeoSummary.avgGeoScore, scored: seoGeoSummary.scoredArticles }, nextActions }, null, 2));
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
    process.exitCode = 1;
  } finally {
    await my.closePool();
  }
}

main();
