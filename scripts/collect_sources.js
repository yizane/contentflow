#!/usr/bin/env node
// collect_sources.js — 选题源采集（DB-only：直接写 MySQL source_items，不输出文件）
const my = require('./mysql_lib');
const { collectSources } = require('./pipeline_lib');

async function main() {
  const engineRunId = process.env.ENGINE_RUN_ID || null;
  try {
    const { summary, warnings } = await collectSources({ engineRunId });
    console.log(JSON.stringify({ ok: true, engineRunId, summary, warnings: warnings.slice(0, 15) }, null, 2));
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
    process.exitCode = 1;
  } finally {
    await my.closePool();
  }
}

main();
