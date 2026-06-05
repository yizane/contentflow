#!/usr/bin/env node
// review_mark.js — 人工终审状态标记（DB-only：写 review_actions + articles.status）
// 用法: npm run review:mark -- --article-id <id> --status reviewed [--note "..."] [--dry-run]
const my = require('../lib/mysql_lib');

const ALLOWED_TARGET = ['reviewed', 'approved_for_publish', 'archived', 'rejected', 'ready_for_review'];

function checkTransition(from, to, note) {
  if ((to === 'reviewed' || to === 'approved_for_publish') && !['ready_for_review', 'reviewed'].includes(from)) {
    return `只有 ready_for_review / reviewed 可进入 ${to}（当前: ${from}）`;
  }
  if (to === 'ready_for_review' && from !== 'reviewed') return `只能从 reviewed 回退（当前: ${from}）`;
  if (to === 'archived' && from === 'published') return 'published 不能归档';
  if (to === 'rejected' && !note) return 'rejected 必须带 --note';
  return null;
}

function parseArgs(argv) {
  const args = { articleId: null, slug: null, status: null, note: '', dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--article-id') args.articleId = argv[++i];
    else if (argv[i] === '--slug') args.slug = argv[++i];
    else if (argv[i] === '--status') args.status = argv[++i];
    else if (argv[i] === '--note') args.note = argv[++i];
    else if (argv[i] === '--dry-run') args.dryRun = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if ((!args.articleId && !args.slug) || !args.status || !ALLOWED_TARGET.includes(args.status)) {
    console.log(JSON.stringify({ ok: false, error: `用法: --article-id/--slug + --status <${ALLOWED_TARGET.join('|')}> [--note] [--dry-run]` }, null, 2));
    process.exit(1);
  }
  try {
    const articles = await my.findArticles({ articleId: args.articleId, slug: args.slug, limit: 1 });
    if (articles.length === 0) {
      console.log(JSON.stringify({ ok: false, error: `未找到文章` }, null, 2));
      process.exitCode = 1;
      return;
    }
    const article = articles[0];
    const violation = checkTransition(article.status, args.status, args.note);
    if (violation) {
      console.log(JSON.stringify({ ok: false, articleId: article.id, beforeStatus: article.status, requestedStatus: args.status, error: violation }, null, 2));
      process.exitCode = 1;
      return;
    }
    const now = my.now();
    if (args.dryRun) {
      await my.insert('review_actions', { id: my.makeId('review'), article_id: article.id, before_status: article.status, after_status: args.status, action: 'mark', note: args.note || null, actor: 'cli', dry_run: 1, created_at: now });
      console.log(JSON.stringify({ ok: true, dryRun: true, articleId: article.id, beforeStatus: article.status, afterStatus: args.status, message: 'dry-run：转换合法，未修改状态（审计已记 dry_run=1）' }, null, 2));
      return;
    }
    await my.update('articles', { status: args.status, updated_at: now }, 'id = ?', [article.id]);
    await my.insert('review_actions', { id: my.makeId('review'), article_id: article.id, before_status: article.status, after_status: args.status, action: 'mark', note: args.note || null, actor: 'cli', dry_run: 0, created_at: now });
    const trace = require('../lib/trace_lib');
    await trace.logStatusTransition({ entityType: 'article', entityId: article.id, fromStatus: article.status, toStatus: args.status, reason: args.note || 'manual review mark', actor: 'reviewer' });
    console.log(JSON.stringify({ ok: true, articleId: article.id, beforeStatus: article.status, afterStatus: args.status, note: args.note }, null, 2));
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
    process.exitCode = 1;
  } finally {
    await my.closePool();
  }
}

main();
