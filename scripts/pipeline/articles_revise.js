#!/usr/bin/env node
// articles_revise.js — 单独执行文章修订（DB-only 薄壳；依赖最新版本的 source_resolution_json）
const my = require('../lib/mysql_lib');
const { reviseArticleWithResolution } = require('../lib/pipeline_lib');

async function main() {
  const argv = process.argv;
  let articleId = null;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--article-id') articleId = argv[++i];
  }
  try {
    const articles = await my.findArticles({ articleId, status: articleId ? null : 'needs_fact_sources', limit: 1 });
    if (articles.length === 0) {
      console.log(JSON.stringify({ ok: false, error: '没有目标文章' }, null, 2));
      process.exitCode = 1;
      return;
    }
    const ver = await my.latestVersion(articles[0].id);
    const resolution = my.asJson(ver && ver.source_resolution_json);
    if (!resolution) {
      console.log(JSON.stringify({ ok: false, error: '最新版本无 source_resolution_json，先运行 npm run sources:resolve' }, null, 2));
      process.exitCode = 1;
      return;
    }
    const r = await reviseArticleWithResolution(articles[0], resolution, { engineRunId: null });
    console.log(JSON.stringify({ ok: r.ok, articleId: articles[0].id, versionId: r.versionId || null, error: r.error || null, warnings: r.warnings || [] }, null, 2));
    if (!r.ok) process.exitCode = 1;
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
    process.exitCode = 1;
  } finally {
    await my.closePool();
  }
}

main();
