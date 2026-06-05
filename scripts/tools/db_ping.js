#!/usr/bin/env node
// db_ping.js — MySQL 连通性检查
const { query, closePool, configFromEnv } = require('../lib/mysql_lib');

async function main() {
  const cfg = configFromEnv();
  try {
    const rows = await query('SELECT VERSION() AS version, DATABASE() AS db, NOW(3) AS server_time');
    console.log(JSON.stringify({ ok: true, host: `${cfg.host}:${cfg.port}`, database: rows[0].db, mysqlVersion: rows[0].version, serverTime: String(rows[0].server_time) }, null, 2));
  } catch (err) {
    console.log(JSON.stringify({ ok: false, host: `${cfg.host}:${cfg.port}`, error: `MySQL 连接失败: ${err.message}。请检查 .env 配置与 MySQL 服务状态。` }, null, 2));
    process.exit(1);
  } finally {
    await closePool();
  }
}

main();
