#!/usr/bin/env node
// factcheck_run.js — 对 article_validated 状态的文章批量事实核查（DB-only）
// 用法: npm run factcheck:run [-- --article-id <id>]
const my = require('../lib/mysql_lib');
const { factCheckArticle } = require('../lib/pipeline_lib');

async function main() {
  const engineRunId = process.env.ENGINE_RUN_ID || null;
  let articleId = null;
  let limit = 20;
  const argv = process.argv;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--article-id') articleId = argv[++i];
    else if (argv[i] === '--limit') limit = Math.max(1, Math.min(50, parseInt(argv[++i], 10) || 20));
  }
  try {
    let articles;
    if (articleId) {
      articles = await my.query('SELECT * FROM articles WHERE id = ?', [articleId]);
    } else {
      const params = [];
      let sql = "SELECT * FROM articles WHERE status = 'article_validated'";
      if (engineRunId) { sql += ' AND engine_run_id = ?'; params.push(engineRunId); }
      sql += ` ORDER BY created_at ASC LIMIT ${limit}`;
      articles = await my.query(sql, params);
    }
    if (articles.length === 0) {
      console.log(JSON.stringify({ ok: false, error: '没有待核查的文章（status=article_validated）' }, null, 2));
      process.exitCode = 1;
      return;
    }
    const results = [];
    for (const a of articles) {
      try {
        results.push(await factCheckArticle(a, { engineRunId }));
      } catch (err) {
        results.push({ ok: false, articleId: a.id, error: err.message });
      }
    }
    const succeeded = results.filter((r) => r.ok).length;
    const failed = results.length - succeeded;
    console.log(JSON.stringify({ ok: failed === 0, succeeded, failed, results }, null, 2));
    if (succeeded === 0 && failed > 0) process.exitCode = 1;
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
    process.exitCode = 1;
  } finally {
    await my.closePool();
  }
}

main();
