#!/usr/bin/env node
// run_topic_generation.js — 主题池生成（DB-only：MySQL source_items → OpenClaw → topic_candidates）
const my = require('./mysql_lib');
const { generateTopics } = require('./pipeline_lib');

async function main() {
  const engineRunId = process.env.ENGINE_RUN_ID || null;
  try {
    const r = await generateTopics({ engineRunId });
    console.log(JSON.stringify(r, null, 2));
    if (!r.ok) process.exitCode = 1;
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
    process.exitCode = 1;
  } finally {
    await my.closePool();
  }
}

main();
