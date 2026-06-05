#!/usr/bin/env node
// db_migrate.js — MySQL migration 执行器
// 1) 应用 db/mysql_schema.sql（幂等 CREATE TABLE IF NOT EXISTS）
// 2) 按文件名顺序执行 db/mysql_migrations/*.sql（schema_migrations 跟踪，已应用跳过）
const fs = require('fs');
const path = require('path');
const { ROOT, exec, query, insert, now, closePool } = require('./mysql_lib');

const MIGRATIONS_DIR = path.join(ROOT, 'db', 'mysql_migrations');

async function main() {
  try {
    await exec(fs.readFileSync(path.join(ROOT, 'db', 'mysql_schema.sql'), 'utf8'));

    const appliedRows = await query('SELECT id FROM schema_migrations');
    const applied = new Set(appliedRows.map((r) => r.id));
    const files = fs.existsSync(MIGRATIONS_DIR) ? fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort() : [];

    const ran = [];
    const skipped = [];
    for (const file of files) {
      if (applied.has(file)) {
        skipped.push(file);
        continue;
      }
      await exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
      await insert('schema_migrations', { id: file, executed_at: now() });
      ran.push(file);
    }

    const tables = await query("SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME");
    console.log(JSON.stringify({ ok: true, backend: 'mysql', schemaApplied: true, ran, skipped, tables: tables.map((r) => r.t) }, null, 2));
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
    process.exit(1);
  } finally {
    await closePool();
  }
}

main();
