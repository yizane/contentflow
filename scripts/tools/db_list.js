#!/usr/bin/env node
// db_list.js — 列出文章（MySQL）
// 用法: npm run db:list [-- --status X] [--json] [--limit N] [--with-scores]
const my = require('../lib/mysql_lib');

function parseArgs(argv) {
  const args = { json: false, status: null, limit: 20, withScores: false, contentType: null, businessCategory: null, topicCluster: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--status') args.status = argv[++i];
    else if (argv[i] === '--limit') args.limit = parseInt(argv[++i], 10) || 20;
    else if (argv[i] === '--with-scores') args.withScores = true;
    else if (argv[i] === '--content-type') args.contentType = argv[++i];
    else if (argv[i] === '--business-category') args.businessCategory = argv[++i];
    else if (argv[i] === '--topic-cluster') args.topicCluster = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  try {
    let sql = 'SELECT id, created_at, title, primary_keyword, status, quality_score, seo_score, geo_score, fact_publish_readiness, slug, current_version_id, content_type, business_category, topic_cluster FROM articles';
    const where = [];
    const params = [];
    if (args.status) { where.push('status = ?'); params.push(args.status); }
    if (args.contentType) { where.push('content_type = ?'); params.push(args.contentType); }
    if (args.businessCategory) { where.push('business_category = ?'); params.push(args.businessCategory); }
    if (args.topicCluster) { where.push('topic_cluster = ?'); params.push(args.topicCluster); }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ` ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(200, args.limit))}`;
    const rows = await my.query(sql, params);

    if (args.json) {
      console.log(JSON.stringify({ ok: true, count: rows.length, articles: rows.map((r) => ({ ...r, created_at: String(r.created_at) })) }, null, 2));
      return;
    }
    if (rows.length === 0) {
      const f = [args.status && `status=${args.status}`, args.contentType && `content_type=${args.contentType}`, args.businessCategory && `business_category=${args.businessCategory}`, args.topicCluster && `topic_cluster=${args.topicCluster}`].filter(Boolean).join(', ');
      console.log(f ? `没有符合（${f}）的文章。` : '没有文章记录。');
      return;
    }
    const cut = (s, n) => {
      const str = String(s ?? '-');
      return str.length > n ? str.slice(0, n - 1) + '…' : str;
    };
    const scoreCols = args.withScores ? ['SEO'.padEnd(4), 'GEO'.padEnd(4)] : [];
    console.log(['created_at'.padEnd(20), 'title'.padEnd(30), 'status'.padEnd(20), 'score', ...scoreCols, 'content_type'.padEnd(16), 'biz_category'.padEnd(18), 'readiness'.padEnd(20), 'slug'].join('  '));
    console.log('-'.repeat(170));
    for (const r of rows) {
      const scoreVals = args.withScores ? [String(r.seo_score ?? '-').padEnd(4), String(r.geo_score ?? '-').padEnd(4)] : [];
      console.log([cut(String(r.created_at), 20).padEnd(20), cut(r.title, 30).padEnd(30), cut(r.status, 20).padEnd(20), String(r.quality_score ?? '-').padEnd(5), ...scoreVals, cut(r.content_type, 16).padEnd(16), cut(r.business_category, 18).padEnd(18), cut(r.fact_publish_readiness, 20).padEnd(20), r.slug || '-'].join('  '));
    }
    console.log(`\n共 ${rows.length} 条（--json / --status <s> / --content-type <t> / --business-category <c> / --topic-cluster <tc> / --with-scores / --limit <n>）`);
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
    process.exitCode = 1;
  } finally {
    await my.closePool();
  }
}

main();
