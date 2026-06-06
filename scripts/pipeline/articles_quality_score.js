#!/usr/bin/env node
// articles_quality_score.js — 文章质量主评分 CLI（Phase 13）
// 主评分 >= 80 才能进终审；SEO/GEO 是辅助建议线，不能覆盖质量不足。
// 用法:
//   npm run score:article-quality -- --status ready_for_review
//   npm run score:article-quality -- --article-id <id> [--force]
//   npm run score:article-quality -- --all --limit 10
const my = require('../lib/mysql_lib');

function parseArgs(argv) {
  const args = { status: null, articleId: null, all: false, limit: 10, force: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--status') args.status = argv[++i];
    else if (argv[i] === '--article-id') args.articleId = argv[++i];
    else if (argv[i] === '--all') args.all = true;
    else if (argv[i] === '--limit') args.limit = Math.max(1, Math.min(50, parseInt(argv[++i], 10) || 10));
    else if (argv[i] === '--force') args.force = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.status && !args.articleId && !args.all) {
    console.log(JSON.stringify({ ok: false, error: '用法: --status <s> | --article-id <id> | --all，可加 --force（重评已有分数）' }, null, 2));
    process.exit(1);
  }
  const engineRunId = process.env.ENGINE_RUN_ID || null;
  try {
    const { scoreArticleQuality, ARTICLE_QUALITY_MIN } = require('../lib/pipeline_lib');
    const { validateVisualPlan } = require('../lib/validate_data_lib');
    let sql = "SELECT * FROM articles WHERE status NOT IN ('archived')";
    const params = [];
    if (args.articleId) { sql += ' AND id = ?'; params.push(args.articleId); }
    if (args.status) { sql += ' AND status = ?'; params.push(args.status); }
    sql += ` ORDER BY created_at DESC LIMIT ${args.limit}`;
    const articles = await my.query(sql, params);
    if (!articles.length) {
      console.log(JSON.stringify({ ok: false, error: '没有符合条件的文章' }, null, 2));
      process.exitCode = 1;
      return;
    }

    const results = [];
    for (const a of articles) {
      const r = await scoreArticleQuality(a, { engineRunId, force: args.force });
      // visualPlan 检查（缺失只 warning + revision 建议，不强改旧文）
      const ver = await my.latestVersion(a.id);
      const vp = my.asJson(ver && ver.visual_plan_json) || (my.asJson(ver && ver.article_json) || {}).visualPlan || null;
      const vpCheck = validateVisualPlan(vp, ver ? ver.article_markdown : '', a.content_type);
      results.push({
        articleId: a.id, title: a.title.slice(0, 40), status: a.status,
        ...((r.ok && !r.skipped) ? { articleQualityScore: r.articleQualityScore, recommendation: r.recommendation, mustFix: r.mustFix.slice(0, 3) }
          : r.skipped ? { articleQualityScore: r.articleQualityScore, skipped: true, hint: '已有评分，--force 可重评' }
          : { error: r.error }),
        blocksReview: r.ok && r.articleQualityScore != null && r.articleQualityScore < ARTICLE_QUALITY_MIN ? `质量分 < ${ARTICLE_QUALITY_MIN}，不得进入 ready_for_review` : undefined,
        visualPlan: vp ? { count: vp.length, warnings: vpCheck.warnings.slice(0, 3) } : { count: 0, suggestion: '旧文章缺 visualPlan：可运行 npm run sources:fix 触发修订生成带视觉规划的新版本（不强制）' },
      });
    }
    console.log(JSON.stringify({ ok: true, qualityMin: ARTICLE_QUALITY_MIN, count: results.length, results }, null, 2));
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
    process.exitCode = 1;
  } finally {
    await my.closePool();
  }
}

main();
