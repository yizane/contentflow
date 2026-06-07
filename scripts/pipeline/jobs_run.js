#!/usr/bin/env node
// jobs_run.js — 执行 pending article_jobs（DB-only：结果直接写 MySQL，不输出文件）
const my = require('../lib/mysql_lib');
const { runArticleJob } = require('../lib/pipeline_lib');

function parseArgs(argv) {
  const args = { limit: 20, includeFailed: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--limit') args.limit = Math.max(1, Math.min(50, parseInt(argv[++i], 10) || 20));
    else if (argv[i] === '--include-failed') args.includeFailed = true;
  }
  return args;
}

async function main() {
  const engineRunId = process.env.ENGINE_RUN_ID || null;
  const args = parseArgs(process.argv);
  try {
    const statuses = args.includeFailed ? "'pending', 'failed'" : "'pending'";
    const params = [];
    let sql = `SELECT * FROM article_jobs WHERE status IN (${statuses})`;
    if (engineRunId) { sql += ' AND engine_run_id = ?'; params.push(engineRunId); }
    sql += ` ORDER BY created_at ASC LIMIT ${args.limit}`;
    const jobs = await my.query(sql, params);
    if (jobs.length === 0) {
      console.log(JSON.stringify({ ok: false, error: '没有待执行的 article_jobs', engineRunId, includeFailed: args.includeFailed, hint: '先运行 npm run jobs:create' }, null, 2));
      process.exitCode = 1;
      return;
    }
    const results = [];
    for (const job of jobs) {
      try {
        results.push(await runArticleJob(job, { engineRunId }));
      } catch (err) {
        await my.update('article_jobs', { status: 'failed', error_message: err.message.slice(0, 900), updated_at: my.now() }, 'id = ?', [job.id]);
        results.push({ ok: false, jobId: job.id, failures: [err.message] });
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
