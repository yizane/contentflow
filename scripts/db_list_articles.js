#!/usr/bin/env node
// db_list_articles.js — 列出文章（MySQL）
// 用法: npm run db:list [-- --status X] [--json] [--limit N] [--with-scores]
const my = require('./mysql_lib');

function parseArgs(argv) {
  const args = { json: false, status: null, limit: 20, withScores: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--status') args.status = argv[++i];
    else if (argv[i] === '--limit') args.limit = parseInt(argv[++i], 10) || 20;
    else if (argv[i] === '--with-scores') args.withScores = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  try {
    let sql = 'SELECT id, created_at, title, primary_keyword, status, quality_score, seo_score, geo_score, fact_publish_readiness, slug, current_version_id FROM articles';
    const params = [];
    if (args.status) { sql += ' WHERE status = ?'; params.push(args.status); }
    sql += ` ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(200, args.limit))}`;
    const rows = await my.query(sql, params);

    if (args.json) {
      console.log(JSON.stringify({ ok: true, count: rows.length, articles: rows.map((r) => ({ ...r, created_at: String(r.created_at) })) }, null, 2));
      return;
    }
    if (rows.length === 0) {
      console.log(args.status ? `没有 status=${args.status} 的文章。` : '没有文章记录。');
      return;
    }
    const cut = (s, n) => {
      const str = String(s ?? '-');
      return str.length > n ? str.slice(0, n - 1) + '…' : str;
    };
    const scoreCols = args.withScores ? ['SEO'.padEnd(4), 'GEO'.padEnd(4)] : [];
    console.log(['created_at'.padEnd(20), 'title'.padEnd(34), 'status'.padEnd(22), 'score', ...scoreCols, 'readiness'.padEnd(22), 'slug'].join('  '));
    console.log('-'.repeat(150));
    for (const r of rows) {
      const scoreVals = args.withScores ? [String(r.seo_score ?? '-').padEnd(4), String(r.geo_score ?? '-').padEnd(4)] : [];
      console.log([cut(String(r.created_at), 20).padEnd(20), cut(r.title, 34).padEnd(34), cut(r.status, 22).padEnd(22), String(r.quality_score ?? '-').padEnd(5), ...scoreVals, cut(r.fact_publish_readiness, 22).padEnd(22), r.slug || '-'].join('  '));
    }
    console.log(`\n共 ${rows.length} 条（--json / --status <s> / --with-scores / --limit <n>）`);
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
    process.exitCode = 1;
  } finally {
    await my.closePool();
  }
}

main();
