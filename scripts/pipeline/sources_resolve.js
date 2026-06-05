#!/usr/bin/env node
// sources_resolve.js — 单独执行来源补全（DB-only 薄壳，完整闭环用 sources:fix）
const my = require('../lib/mysql_lib');
const { resolveSourcesForArticle } = require('../lib/pipeline_lib');

async function main() {
  const argv = process.argv;
  let articleId = null;
  let limit = 1;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--article-id') articleId = argv[++i];
    else if (argv[i] === '--limit') limit = parseInt(argv[++i], 10) || 1;
  }
  try {
    const articles = await my.findArticles({ articleId, status: articleId ? null : 'needs_fact_sources', limit });
    if (articles.length === 0) {
      console.log(JSON.stringify({ ok: false, error: '没有目标文章' }, null, 2));
      process.exitCode = 1;
      return;
    }
    const results = [];
    for (const a of articles) results.push({ articleId: a.id, ...(await resolveSourcesForArticle(a, { engineRunId: null })) });
    console.log(JSON.stringify({ ok: results.some((r) => r.ok), results: results.map((r) => ({ articleId: r.articleId, ok: r.ok, summary: r.summary, error: r.error })) }, null, 2));
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
    process.exitCode = 1;
  } finally {
    await my.closePool();
  }
}

main();
