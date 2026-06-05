// classify_lib.js — 内容分类引擎（规则优先 + OpenClaw 兜底），结果写 MySQL
// 流程：规则分类 confidence >= RULE_CONFIDENT(0.85) 直接采用；否则批量调 OpenClaw content_classifier。
// 写入：实体表分类字段 + content_classifications 审计表 + workflow_events；AI 调用经 callAgent 自动记 model_runs。
const my = require('./mysql_lib');
const tax = require('./taxonomy_lib');
const trace = require('./trace_lib');

const RULE_CONFIDENT = 0.85;
const DEFAULT_AI_BATCH = 15;

// 实体适配：取数 SQL 与分类输入 / 写回字段
const ENTITIES = {
  source_items: {
    fetch: (where, limit) => my.query(
      `SELECT id, title, summary, source_group, source_name FROM source_items ${where} ORDER BY created_at DESC LIMIT ${limit}`),
    unclassifiedWhere: 'WHERE content_type IS NULL OR business_category IS NULL', // 低置信规则结果可能只填了部分维度，回填要能补完
    toInput: (r) => ({ title: r.title || '', summary: r.summary || '', sourceGroup: r.source_group, sourceName: r.source_name }),
    write: async (id, c, now) => my.update('source_items', {
      content_type: c.contentType, business_category: c.businessCategory, topic_cluster: c.topicCluster,
      classification_confidence: c.confidence, classification_reason: c.reason,
    }, 'id = ?', [id]),
  },
  topic_candidates: {
    fetch: (where, limit) => my.query(
      `SELECT id, topic, content_angle, business_angle, category, primary_keyword FROM topic_candidates ${where} ORDER BY created_at DESC LIMIT ${limit}`),
    unclassifiedWhere: 'WHERE content_type IS NULL OR business_category IS NULL', // 低置信规则结果可能只填了部分维度，回填要能补完
    toInput: (r) => ({
      title: r.topic || '', summary: [r.content_angle, r.business_angle].filter(Boolean).join('；'),
      sourceGroup: null, sourceName: null, keywords: [r.primary_keyword].filter(Boolean),
    }),
    write: async (id, c, now) => my.update('topic_candidates', {
      content_type: c.contentType, business_category: c.businessCategory, topic_cluster: c.topicCluster,
      classification_confidence: c.confidence, classification_reason: c.reason, updated_at: now,
    }, 'id = ?', [id]),
  },
  articles: {
    fetch: (where, limit) => my.query(
      `SELECT id, title, primary_keyword, secondary_keywords_json FROM articles ${where} ORDER BY created_at DESC LIMIT ${limit}`),
    unclassifiedWhere: 'WHERE content_type IS NULL OR business_category IS NULL', // 低置信规则结果可能只填了部分维度，回填要能补完
    toInput: (r) => ({
      title: r.title || '', summary: '', sourceGroup: null, sourceName: null,
      keywords: [r.primary_keyword, ...(my.asJson(r.secondary_keywords_json) || [])].filter(Boolean).slice(0, 6),
    }),
    write: async (id, c, now) => {
      await my.update('articles', {
        content_type: c.contentType, business_category: c.businessCategory, topic_cluster: c.topicCluster, updated_at: now,
      }, 'id = ?', [id]);
      // 文章的所有版本同步（版本无独立分类语义，跟随文章）
      await my.query('UPDATE article_versions SET content_type = ?, business_category = ?, topic_cluster = ?, updated_at = ? WHERE article_id = ?',
        [c.contentType, c.businessCategory, c.topicCluster, now, id]);
    },
  },
};

async function recordClassification({ entityType, entityId, c, classifierType, modelRunId, raw }) {
  await my.insert('content_classifications', {
    id: my.makeId('cls'), entity_type: entityType, entity_id: entityId,
    content_type: c.contentType, business_category: c.businessCategory, topic_cluster: c.topicCluster,
    confidence: c.confidence, reason: c.reason, classifier_type: classifierType,
    model_run_id: modelRunId || null, raw_json: raw || null, created_at: my.now(),
  });
}

// AI 批量分类：返回 Map(index → normalized classification)
async function aiClassifyBatch({ items, engineRunId }) {
  const { callAgent } = require('./pipeline_lib'); // 延迟 require 防循环依赖
  const prompts = require('./prompt_lib');
  const r = await callAgent({
    taskType: 'content_classification',
    prompt: prompts.classificationPrompt({ items }),
    sessionKey: `agent:main:classify-${Date.now() % 1e6}`,
    engineRunId, timeoutSec: 600,
  });
  if (!r.ok) return { ok: false, error: r.error, modelRunId: r.modelRunId, byIndex: new Map() };
  const arr = Array.isArray(r.data) ? r.data : [r.data];
  const byIndex = new Map();
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const norm = tax.normalizeClassification(item);
    if (norm && norm.contentType && norm.businessCategory) byIndex.set(Number(item.index), norm);
  }
  return { ok: true, modelRunId: r.modelRunId, byIndex };
}

/**
 * 给一批已取出的行做分类（规则优先，低置信走 AI）。
 * @returns {{ classified, byRules, byAi, failed, lowConfidence: [{id,title,confidence,reason}] }}
 */
async function classifyRows({ entity, rows, engineRunId = null, aiBatch = DEFAULT_AI_BATCH, maxAiCalls = Infinity, noAi = false }) {
  const adapter = ENTITIES[entity];
  if (!adapter) throw new Error(`未知实体: ${entity}`);
  await require('./config_lib').ensureInit();
  const now = my.now();

  const stats = { classified: 0, byRules: 0, byAi: 0, failed: 0, lowConfidence: [] };
  const needAi = []; // { row, input, rule }

  // 1) 规则分类
  for (const row of rows) {
    const input = adapter.toInput(row);
    const rule = tax.classifyByRules(input);
    if (rule && rule.contentType && rule.businessCategory && rule.confidence >= RULE_CONFIDENT) {
      await adapter.write(row.id, rule, now);
      await recordClassification({ entityType: entity, entityId: row.id, c: rule, classifierType: 'rules' });
      stats.classified++;
      stats.byRules++;
    } else {
      needAi.push({ row, input, rule });
    }
  }

  // 2) AI 兜底（批量）
  let aiCalls = 0;
  let cursor = 0;
  while (cursor < needAi.length && !noAi && aiCalls < maxAiCalls) {
    const batch = needAi.slice(cursor, cursor + aiBatch);
    cursor += batch.length;
    aiCalls++;
    const items = batch.map((b, i) => ({
      index: i + 1, ...b.input,
      ruleHint: b.rule ? `${b.rule.contentType || '-'} / ${b.rule.businessCategory || '-'}（conf ${b.rule.confidence}）` : null,
    }));
    const res = await aiClassifyBatch({ items, engineRunId });
    for (let i = 0; i < batch.length; i++) {
      const { row, rule } = batch[i];
      const ai = res.byIndex.get(i + 1);
      const final = ai || rule; // AI 失败/缺项 → 回退规则结果（可能低置信）
      if (!final || !final.contentType) {
        stats.failed++;
        await trace.logWorkflowEvent({
          engineRunId, eventType: 'content_classify_failed', level: 'warning',
          message: `${entity} ${row.id} 分类失败（规则无信号且 AI ${res.ok ? '未返回该条' : '调用失败'}）`,
          relatedType: entity, relatedId: row.id,
        });
        continue;
      }
      if (!ai && final.reason) final.reason = `${final.reason}（AI 兜底失败，沿用规则低置信结果）`;
      await adapter.write(row.id, final, my.now());
      await recordClassification({
        entityType: entity, entityId: row.id, c: final,
        classifierType: ai ? 'openclaw' : 'rules', modelRunId: ai ? res.modelRunId : null, raw: ai || null,
      });
      stats.classified++;
      if (ai) stats.byAi++; else stats.byRules++;
      if ((final.confidence ?? 0) < 0.7) {
        stats.lowConfidence.push({ id: row.id, title: (batch[i].input.title || '').slice(0, 60), confidence: final.confidence, reason: (final.reason || '').slice(0, 120) });
        await trace.logWorkflowEvent({
          engineRunId, eventType: 'content_classify_low_confidence', level: 'warning',
          message: `${entity} ${row.id} 分类置信度低（${final.confidence}）: ${(final.reason || '').slice(0, 150)}`,
          relatedType: entity, relatedId: row.id, data: final,
        });
      }
    }
  }
  // noAi / 超出 AI 预算的剩余条目：写入规则低置信结果（有则写，无则留空）
  for (let i = cursor; i < needAi.length; i++) {
    const { row, rule } = needAi[i];
    if (rule && rule.contentType) {
      await adapter.write(row.id, rule, my.now());
      await recordClassification({ entityType: entity, entityId: row.id, c: rule, classifierType: 'rules' });
      stats.classified++;
      stats.byRules++;
      stats.lowConfidence.push({ id: row.id, title: (needAi[i].input.title || '').slice(0, 60), confidence: rule.confidence, reason: '(超出 AI 预算，规则低置信)' });
    } else {
      stats.failed++;
    }
  }

  await trace.logWorkflowEvent({
    engineRunId, eventType: 'content_classified', level: 'info',
    message: `${entity} 分类完成: ${stats.classified}/${rows.length}（规则 ${stats.byRules} / AI ${stats.byAi} / 失败 ${stats.failed}）`,
    relatedType: entity, data: { ...stats, lowConfidence: stats.lowConfidence.slice(0, 5) },
  });
  return stats;
}

/** 按实体取未分类（或 --force 全量）行并分类 */
async function classifyEntity({ entity, limit = 100, force = false, engineRunId = null, aiBatch = DEFAULT_AI_BATCH, maxAiCalls = Infinity, noAi = false }) {
  const adapter = ENTITIES[entity];
  if (!adapter) throw new Error(`未知实体: ${entity}`);
  const where = force ? '' : adapter.unclassifiedWhere;
  const rows = await adapter.fetch(where, Math.max(1, Math.min(2000, limit)));
  if (!rows.length) return { entity, total: 0, classified: 0, byRules: 0, byAi: 0, failed: 0, lowConfidence: [] };
  const stats = await classifyRows({ entity, rows, engineRunId, aiBatch, maxAiCalls, noAi });
  return { entity, total: rows.length, ...stats };
}

module.exports = { classifyRows, classifyEntity, RULE_CONFIDENT, ENTITIES };
