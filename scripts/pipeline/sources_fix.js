#!/usr/bin/env node
// sources_fix.js — needs_fact_sources → ready_for_review 修订闭环（DB-only）
// 流程: 来源补全 → 文章修订（新 version）→ 修订稿重新核查 → 状态推进，全部写 MySQL
// 用法:
//   npm run sources:fix -- --limit 1
//   npm run sources:fix -- --article-id <id> [--force]
//   npm run sources:fix -- --slug <slug>
const my = require('../lib/mysql_lib');
const { resolveSourcesForArticle, reviseArticleWithResolution, factCheckArticle } = require('../lib/pipeline_lib');

function parseArgs(argv) {
  const args = { articleId: null, slug: null, limit: 1, force: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--article-id') args.articleId = argv[++i];
    else if (argv[i] === '--slug') args.slug = argv[++i];
    else if (argv[i] === '--limit') args.limit = parseInt(argv[++i], 10) || 1;
    else if (argv[i] === '--force') args.force = true;
  }
  return args;
}

async function processArticle(article, engineRunId, warnings, errors) {
  const item = { articleId: article.id, title: article.title, beforeStatus: article.status, afterStatus: article.status, sourceResolution: {}, factCheck: {} };

  // 1) 来源补全
  const sr = await resolveSourcesForArticle(article, { engineRunId });
  if (!sr.ok) {
    errors.push(`${article.id} 来源补全失败: ${sr.error}`);
    return { ...item, failed: true };
  }
  item.sourceResolution = sr.summary;

  // 2) 修订（写新 version）
  const rev = await reviseArticleWithResolution(article, sr.resolution, { engineRunId });
  if (!rev.ok) {
    errors.push(`${article.id} 修订失败: ${rev.error}`);
    return { ...item, failed: true };
  }
  warnings.push(...(rev.warnings || []).map((w) => `${article.id}: ${w}`));

  // 3) 修订稿重新核查（factCheckArticle 用最新版本 = 刚写入的修订版）
  const fc = await factCheckArticle(article, { engineRunId });
  if (!fc.ok) {
    errors.push(`${article.id} 重新核查失败: ${fc.error}`);
    return { ...item, failed: true };
  }
  item.factCheck = { publishReadiness: fc.publishReadiness, mustFix: fc.mustFix };
  item.afterStatus = fc.articleStatus;
  if (fc.articleStatus === 'needs_fact_sources') {
    warnings.push(`${article.id}: 修订后仍 needs_fact_sources，剩余 mustFix ${fc.mustFix} 条`);
  }
  return item;
}

async function main() {
  const args = parseArgs(process.argv);
  const engineRunId = process.env.ENGINE_RUN_ID || null;
  try {
    let articles = await my.findArticles({ articleId: args.articleId, slug: args.slug, status: args.articleId || args.slug ? null : 'needs_fact_sources', limit: args.limit });

    const explicit = !!(args.articleId || args.slug);
    if (explicit && articles.length > 0 && articles[0].status !== 'needs_fact_sources' && !args.force) {
      console.log(JSON.stringify({ ok: true, processed: 0, message: `文章 ${articles[0].id} 状态是 ${articles[0].status}，重修请加 --force` }, null, 2));
      return;
    }
    if (articles.length === 0) {
      console.log(JSON.stringify({ ok: true, processed: 0, message: 'No needs_fact_sources articles found.' }, null, 2));
      return;
    }

    const warnings = [];
    const errors = [];
    const items = [];
    for (const a of articles) {
      try {
        items.push(await processArticle(a, engineRunId, warnings, errors));
      } catch (err) {
        errors.push(`${a.id}: ${err.message}`);
        items.push({ articleId: a.id, title: a.title, beforeStatus: a.status, afterStatus: a.status, failed: true });
      }
    }

    const readyForReview = items.filter((i) => i.afterStatus === 'ready_for_review').length;
    const stillNeedsSources = items.filter((i) => i.afterStatus === 'needs_fact_sources' && !i.failed).length;
    const failed = items.filter((i) => i.failed).length;
    console.log(JSON.stringify({ ok: failed === 0, processed: items.length, readyForReview, stillNeedsSources, failed, items, warnings, errors }, null, 2));
    if (failed === items.length && items.length > 0) process.exitCode = 1;
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
    process.exitCode = 1;
  } finally {
    await my.closePool();
  }
}

main();
