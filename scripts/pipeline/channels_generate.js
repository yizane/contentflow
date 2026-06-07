#!/usr/bin/env node
// channels_generate.js — 渠道改写（DB-only：正文/JSON 直接写 channel_outputs）
// 用法:
//   npm run channels:generate                                   # 默认处理 ready_for_review 的缺渠道文章
//   npm run channels:generate -- --article-id <id> [--force]
//   npm run channels:generate -- --slug <slug>
//   npm run channels:generate -- --status ready_for_review --missing-only
const my = require('../lib/mysql_lib');
const { generateChannelsForArticle, CHANNELS } = require('../lib/pipeline_lib');

function defaultChannelStatuses() {
  return ['ready_for_review'];
}

function parseArgs(argv) {
  const args = { articleId: null, slug: null, status: null, missingOnly: false, force: false, limit: 20 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--article-id') args.articleId = argv[++i];
    else if (argv[i] === '--slug') args.slug = argv[++i];
    else if (argv[i] === '--status') args.status = argv[++i];
    else if (argv[i] === '--missing-only') args.missingOnly = true;
    else if (argv[i] === '--force') args.force = true;
    else if (argv[i] === '--limit') args.limit = parseInt(argv[++i], 10) || 20;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const engineRunId = process.env.ENGINE_RUN_ID || null;
  try {
    let articles;
    if (args.articleId || args.slug || args.status) {
      if (args.status && engineRunId && !args.articleId && !args.slug) {
        articles = await my.query(`SELECT * FROM articles WHERE status = ? AND engine_run_id = ? ORDER BY created_at DESC LIMIT ${args.limit}`, [args.status, engineRunId]);
      } else {
        articles = await my.findArticles({ articleId: args.articleId, slug: args.slug, status: args.status, limit: args.limit });
      }
    } else {
      // 默认：只处理已通过主质量门禁和事实核查的可审稿文章。
      const statuses = defaultChannelStatuses();
      const params = [...statuses];
      let sql = `SELECT * FROM articles WHERE status IN (${statuses.map(() => '?').join(',')})`;
      if (engineRunId) { sql += ' AND engine_run_id = ?'; params.push(engineRunId); }
      sql += ' ORDER BY created_at DESC LIMIT 20';
      articles = await my.query(sql, params);
    }
    if (articles.length === 0) {
      console.log(JSON.stringify({ ok: true, processedArticles: 0, channelOutputsGenerated: 0, skippedExisting: 0, failed: 0, items: [], warnings: ['没有匹配的文章'], errors: [] }, null, 2));
      return;
    }

    const items = [];
    const errors = [];
    for (const a of articles) {
      try {
        const r = await generateChannelsForArticle(a, { engineRunId, missingOnly: args.missingOnly || (!args.force && !args.articleId && !args.slug), force: args.force });
        items.push({ articleId: a.id, slug: a.slug, generated: r.generated, skipped: r.skipped, failed: r.failed.map((f) => f.channel) });
        r.failed.forEach((f) => errors.push(`${a.id}/${f.channel}: ${f.issues.join('; ')}`));
      } catch (err) {
        items.push({ articleId: a.id, slug: a.slug, generated: [], skipped: [], failed: [...CHANNELS] });
        errors.push(`${a.id}: ${err.message}`);
      }
    }
    const generated = items.reduce((s, i) => s + i.generated.length, 0);
    const skipped = items.reduce((s, i) => s + i.skipped.length, 0);
    const failed = items.reduce((s, i) => s + i.failed.length, 0);
    console.log(JSON.stringify({ ok: failed === 0, processedArticles: items.length, channelOutputsGenerated: generated, generated, skippedExisting: skipped, failed, items, warnings: [], errors }, null, 2));
    if (generated === 0 && failed > 0) process.exitCode = 1;
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
    process.exitCode = 1;
  } finally {
    await my.closePool();
  }
}

if (require.main === module) {
  main();
}

module.exports = { defaultChannelStatuses, parseArgs };
