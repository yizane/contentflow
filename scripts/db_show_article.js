#!/usr/bin/env node
// db_show_article.js — 展示单篇文章完整记录（MySQL；--include-content 输出正文）
// 用法:
//   npm run db:show -- --id <article_id>
//   npm run db:show -- --slug <slug> --include-content
//   npm run db:show -- --status ready_for_review --include-content
const my = require('./mysql_lib');

function parseArgs(argv) {
  const args = { id: null, slug: null, status: null, includeContent: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--id' || argv[i] === '--article-id') args.id = argv[++i];
    else if (argv[i] === '--slug') args.slug = argv[++i];
    else if (argv[i] === '--status') args.status = argv[++i];
    else if (argv[i] === '--include-content') args.includeContent = true;
  }
  return args;
}

async function showOne(article, includeContent) {
  const ver = await my.latestVersion(article.id);
  const versions = await my.query('SELECT id, version_label, generation_mode, strategy, status, quality_score, created_at FROM article_versions WHERE article_id = ? ORDER BY created_at', [article.id]);
  const factChecks = await my.query('SELECT overall_risk, publish_readiness, claims_count, high_risk_count, must_fix_count, created_at FROM fact_checks WHERE article_id = ? ORDER BY created_at DESC', [article.id]);
  const scores = await my.query('SELECT strategy, overall_score, seo_score, geo_score, fact_score, recommendation, created_at FROM seo_geo_scores WHERE article_id = ? ORDER BY created_at DESC', [article.id]);
  const channels = await my.query('SELECT channel, title, status, LENGTH(content_markdown) AS content_length FROM channel_outputs WHERE article_id = ? ORDER BY channel', [article.id]);
  const reviews = await my.query('SELECT before_status, after_status, note, dry_run, created_at FROM review_actions WHERE article_id = ? ORDER BY created_at DESC LIMIT 5', [article.id]);

  const out = {
    article: {
      id: article.id, title: article.title, slug: article.slug, status: article.status,
      primaryKeyword: article.primary_keyword, qualityScore: article.quality_score,
      seoScore: article.seo_score, geoScore: article.geo_score,
      publishRecommendation: article.publish_recommendation,
      factPublishReadiness: article.fact_publish_readiness,
      currentVersionId: article.current_version_id,
      createdAt: String(article.created_at), updatedAt: String(article.updated_at),
    },
    versions: versions.map((v) => ({ ...v, created_at: String(v.created_at) })),
    factChecks: factChecks.map((f) => ({ ...f, created_at: String(f.created_at) })),
    seoGeoScores: scores.map((s) => ({ ...s, created_at: String(s.created_at) })),
    channels: channels.map((c) => ({ ...c })),
    reviewActions: reviews.map((r) => ({ ...r, created_at: String(r.created_at) })),
  };
  if (includeContent && ver) {
    const md = ver.article_markdown || '';
    out.content = {
      versionId: ver.id, markdownLength: md.length,
      markdownPreview: md.slice(0, 600) + (md.length > 600 ? '\n…(truncated, 全文在 article_versions.article_markdown)' : ''),
    };
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.id && !args.slug && !args.status) {
    console.log(JSON.stringify({ ok: false, error: '用法: --id <id> | --slug <slug> | --status <s>，可加 --include-content' }, null, 2));
    process.exit(1);
  }
  try {
    const articles = await my.findArticles({ articleId: args.id, slug: args.slug, status: args.status, limit: 10 });
    if (articles.length === 0) {
      console.log(JSON.stringify({ ok: false, error: '未找到文章' }, null, 2));
      process.exitCode = 1;
      return;
    }
    const results = [];
    for (const a of articles) results.push(await showOne(a, args.includeContent));
    console.log(JSON.stringify({ ok: true, count: results.length, results }, null, 2));
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
    process.exitCode = 1;
  } finally {
    await my.closePool();
  }
}

main();
