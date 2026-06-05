#!/usr/bin/env node
// db_init.js — 初始化 MySQL schema（幂等；MySQL 是唯一运行时数据源）
const fs = require('fs');
const path = require('path');
const { ROOT, exec, query, closePool } = require('./mysql_lib');

async function main() {
  const schema = fs.readFileSync(path.join(ROOT, 'db', 'mysql_schema.sql'), 'utf8');
  try {
    await exec(schema);
    const rows = await query("SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME");
    console.log(JSON.stringify({ ok: true, backend: 'mysql', tables: rows.map((r) => r.t) }, null, 2));
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: `schema 初始化失败: ${err.message}` }, null, 2));
    process.exit(1);
  } finally {
    await closePool();
  }
}

main();
