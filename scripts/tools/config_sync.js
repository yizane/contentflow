#!/usr/bin/env node
// config_sync.js — 把仓库配置文件灌入 MySQL（seed → DB）
// 用法:
//   npm run config:sync             # 增量：内容 sha 未变跳过；Web 改过的（updated_by != file-sync）跳过
//   npm run config:sync -- --force  # 覆盖 Web 修改
const fs = require('fs');
const path = require('path');
const my = require('../lib/mysql_lib');
const { loadSources } = require('../lib/sources_lib');
const { boolValue } = require('../lib/source_lanes_lib');

const ROOT = my.ROOT;
const force = process.argv.includes('--force');

async function upsertDoc(key, type, content, stats) {
  const sha = my.sha256(content);
  const existing = (await my.query('SELECT content_sha256, updated_by, version FROM app_configs WHERE config_key = ?', [key]))[0];
  if (existing) {
    if (existing.content_sha256 === sha) { stats.unchanged++; return; }
    if (existing.updated_by && existing.updated_by !== 'file-sync' && !force) {
      stats.skippedWebEdited.push(key);
      return;
    }
    await my.update('app_configs', { content, content_sha256: sha, version: existing.version + 1, updated_by: 'file-sync', updated_at: my.now() }, 'config_key = ?', [key]);
    stats.updated++;
  } else {
    await my.insert('app_configs', { config_key: key, config_type: type, content, content_sha256: sha, version: 1, updated_by: 'file-sync', created_at: my.now(), updated_at: my.now() });
    stats.created++;
  }
}

async function main() {
  const stats = { created: 0, updated: 0, unchanged: 0, skippedWebEdited: [], keywords: { created: 0, updated: 0, unchanged: 0 }, sources: { created: 0, updated: 0, unchanged: 0 } };

  // 1) 文档配置
  const docs = [
    ['internal_claims', 'yaml_doc', 'config/internal_claims.yaml'],
    ['production_policy', 'yaml_doc', 'config/production_policy.yaml'],
    ['models', 'yaml_doc', 'config/models.yaml'],
    ['sources_yaml', 'yaml_doc', 'config/sources.yaml'],
    ['keywords_csv', 'yaml_doc', 'config/keywords.csv'],
    ['content_taxonomy', 'yaml_doc', 'config/content_taxonomy.yaml'],
    ['content_portfolio', 'yaml_doc', 'config/content_portfolio.yaml'],
  ];
  for (const f of fs.readdirSync(path.join(ROOT, 'prompts')).filter((x) => x.endsWith('.md'))) docs.push([`prompt:${f}`, 'prompt', `prompts/${f}`]);
  for (const f of fs.readdirSync(path.join(ROOT, 'schemas')).filter((x) => x.endsWith('.json'))) docs.push([`schema:${f}`, 'schema', `schemas/${f}`]);
  for (const [key, type, rel] of docs) {
    await upsertDoc(key, type, fs.readFileSync(path.join(ROOT, rel), 'utf8'), stats);
  }

  // 2) 关键词（结构化 upsert by keyword）
  const csv = fs.readFileSync(path.join(ROOT, 'config', 'keywords.csv'), 'utf8').trim().split('\n').slice(1);
  for (const line of csv) {
    const [keyword, cluster, intent, priority, stage, business_angle] = line.split(',').map((x) => (x || '').trim());
    if (!keyword) continue;
    const ex = (await my.query('SELECT id, cluster, intent, priority, stage, business_angle FROM config_keywords WHERE keyword = ?', [keyword]))[0];
    if (ex) {
      if (ex.cluster === cluster && ex.intent === intent && ex.priority === priority && ex.stage === stage && ex.business_angle === business_angle) {
        stats.keywords.unchanged++;
      } else {
        await my.update('config_keywords', { cluster, intent, priority, stage, business_angle, updated_at: my.now() }, 'id = ?', [ex.id]);
        stats.keywords.updated++;
      }
    } else {
      await my.insert('config_keywords', { id: my.makeId('kw'), keyword, cluster, intent, priority, stage, business_angle, enabled: 1, created_at: my.now(), updated_at: my.now() });
      stats.keywords.created++;
    }
  }

  // 3) 采集源（结构化 upsert by name）
  const { groups } = loadSources();
  for (const [group, items] of Object.entries(groups)) {
    for (const s of items) {
      const fields = {
        group_name: group, type: s.type || null, category: s.category || null, priority: s.priority || null,
        url: s.url || null, site_url: s.site_url || null, language: s.language || null,
        requires_auth: s.requires_auth === 'true' ? 1 : 0, freshness: s.freshness || null,
        query_text: s.query || null, notes: s.notes || null,
        extra_json: {
          lane: s.lane || null,
          daily_query_enabled: s.daily_query_enabled === undefined ? null : boolValue(s.daily_query_enabled, true),
        },
        enabled: boolValue(s.enabled, true) ? 1 : 0,
      };
      const ex = (await my.query('SELECT * FROM config_sources WHERE name = ?', [s.name]))[0];
      if (ex) {
        const changed = Object.entries(fields).some(([k, v]) => {
          const dbv = ex[k];
          if (k === 'extra_json') return JSON.stringify(my.asJson(dbv) || {}) !== JSON.stringify(v);
          return String(dbv ?? '') !== String(v ?? '');
        });
        if (changed) {
          await my.update('config_sources', { ...fields, updated_at: my.now() }, 'id = ?', [ex.id]);
          stats.sources.updated++;
        } else stats.sources.unchanged++;
      } else {
        await my.insert('config_sources', { id: my.makeId('src'), name: s.name, ...fields, enabled: 1, created_at: my.now(), updated_at: my.now() });
        stats.sources.created++;
      }
    }
  }

  await my.closePool();
  console.log(JSON.stringify({ ok: true, force, docs: { created: stats.created, updated: stats.updated, unchanged: stats.unchanged, skippedWebEdited: stats.skippedWebEdited }, keywords: stats.keywords, sources: stats.sources }, null, 2));
}

main().catch(async (err) => {
  console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
  await my.closePool();
  process.exit(1);
});
