#!/usr/bin/env node
// run_article_jobs.js — 执行 pending article_jobs（DB-only：结果直接写 MySQL，不输出文件）
const my = require('./mysql_lib');
const { runArticleJob } = require('./pipeline_lib');

async function main() {
  const engineRunId = process.env.ENGINE_RUN_ID || null;
  try {
    const jobs = await my.query("SELECT * FROM article_jobs WHERE status IN ('pending', 'failed') ORDER BY created_at ASC LIMIT 20");
    if (jobs.length === 0) {
      console.log(JSON.stringify({ ok: false, error: '没有 pending 的 article_jobs', hint: '先运行 npm run jobs:create-articles' }, null, 2));
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
