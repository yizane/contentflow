#!/usr/bin/env node
// score_seo_geo.js — SEO/GEO 双评分（DB-only：结果写 seo_geo_scores + article_versions）
// 用法: npm run score:seo-geo -- [--article-id <id>|--slug <s>|--status ready_for_review] [--strategy balanced] [--force]
const my = require('../lib/mysql_lib');
const { scoreArticle, WEIGHTS } = require('../lib/pipeline_lib');

function parseArgs(argv) {
  const args = { articleId: null, slug: null, status: null, strategy: 'balanced', limit: 10, force: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--article-id') args.articleId = argv[++i];
    else if (argv[i] === '--slug') args.slug = argv[++i];
    else if (argv[i] === '--status') args.status = argv[++i];
    else if (argv[i] === '--strategy') args.strategy = argv[++i];
    else if (argv[i] === '--limit') args.limit = parseInt(argv[++i], 10) || 10;
    else if (argv[i] === '--force') args.force = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!Object.keys(WEIGHTS).includes(args.strategy)) {
    console.log(JSON.stringify({ ok: false, error: `strategy 非法: ${args.strategy}` }, null, 2));
    process.exit(1);
  }
  const engineRunId = process.env.ENGINE_RUN_ID || null;
  try {
    let articles;
    const status = args.status || (args.articleId || args.slug ? null : 'ready_for_review');
    if (engineRunId && status && !args.articleId && !args.slug) {
      articles = await my.query(`SELECT * FROM articles WHERE status = ? AND engine_run_id = ? ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(100, args.limit))}`, [status, engineRunId]);
    } else {
      articles = await my.findArticles({ articleId: args.articleId, slug: args.slug, status, limit: args.limit });
    }
    if (articles.length === 0) {
      console.log(JSON.stringify({ ok: true, scored: 0, message: '没有匹配的文章' }, null, 2));
      return;
    }
    const results = [];
    for (const a of articles) {
      try {
        results.push(await scoreArticle(a, { engineRunId, strategy: args.strategy, force: args.force }));
      } catch (err) {
        results.push({ ok: false, articleId: a.id, error: err.message });
      }
    }
    const scored = results.filter((r) => r.ok && !r.skipped).length;
    const skipped = results.filter((r) => r.skipped).length;
    const failed = results.filter((r) => !r.ok).length;
    console.log(JSON.stringify({ ok: failed === 0, strategy: args.strategy, scored, skipped, failed, results }, null, 2));
    if (scored === 0 && failed > 0) process.exitCode = 1;
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
    process.exitCode = 1;
  } finally {
    await my.closePool();
  }
}

main();
