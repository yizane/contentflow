#!/usr/bin/env node
// db_init.js — 初始化 MySQL（幂等）：基础 schema + 全部 migrations
// 全新环境一条命令到位；与 db:migrate 共用同一套执行逻辑，避免「init 后缺 migration 列」。
const fs = require('fs');
const path = require('path');
const { ROOT, exec, query, insert, now, closePool } = require('../lib/mysql_lib');

const MIGRATIONS_DIR = path.join(ROOT, 'db', 'mysql_migrations');

async function main() {
  try {
    await exec(fs.readFileSync(path.join(ROOT, 'db', 'mysql_schema.sql'), 'utf8'));

    const applied = new Set((await query('SELECT id FROM schema_migrations')).map((r) => r.id));
    const files = fs.existsSync(MIGRATIONS_DIR) ? fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort() : [];
    const ran = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      await exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
      await insert('schema_migrations', { id: file, executed_at: now() });
      ran.push(file);
    }

    const rows = await query("SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME");
    console.log(JSON.stringify({ ok: true, backend: 'mysql', migrationsRan: ran, tables: rows.map((r) => r.t) }, null, 2));
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: `初始化失败: ${err.message}` }, null, 2));
    process.exit(1);
  } finally {
    await closePool();
  }
}

main();
