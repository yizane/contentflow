// trace_lib.js — workflow trace 统一写入 MySQL
// 原则：trace 写入失败不崩主流程（计数 + console.warn），engine_report 可读取失败计数提示。
const my = require('./mysql_lib');

let traceFailures = 0;
const traceFailureSamples = [];
const stepStartedWallMs = new Map();

async function safe(fn, label) {
  try {
    return await fn();
  } catch (err) {
    traceFailures++;
    if (traceFailureSamples.length < 5) traceFailureSamples.push(`${label}: ${err.message}`);
    console.warn(`[trace] 写入失败（不影响主流程）: ${label}: ${err.message}`);
    return null;
  }
}

function getTraceFailures() {
  return { count: traceFailures, samples: traceFailureSamples };
}

// 截断 summary，避免大全文进 trace
function clip(obj, max = 2000) {
  if (obj === null || obj === undefined) return null;
  const s = JSON.stringify(obj);
  if (s.length <= max) return obj;
  return { _truncated: true, preview: s.slice(0, max) };
}

async function createWorkflowStep({ engineRunId, stepKey, stepName, stepOrder, inputSummary }) {
  const id = my.makeId('step');
  const now = my.now();
  stepStartedWallMs.set(id, Date.now());
  await safe(() => my.insert('workflow_steps', {
    id, engine_run_id: engineRunId || null, step_key: stepKey, step_name: stepName || stepKey,
    step_order: stepOrder ?? null, status: 'pending', started_at: now,
    input_summary_json: clip(inputSummary), created_at: now, updated_at: now,
  }), `createWorkflowStep(${stepKey})`);
  return id;
}

async function startWorkflowStep(stepId) {
  if (!stepId) return;
  const now = my.now();
  stepStartedWallMs.set(stepId, Date.now());
  await safe(() => my.update('workflow_steps', { status: 'running', started_at: now, updated_at: now }, 'id = ?', [stepId]), 'startWorkflowStep');
}

async function finishWorkflowStep(stepId, { status, outputSummary, warnings, errorMessage } = {}) {
  if (!stepId) return;
  await safe(async () => {
    const finished = my.now();
    const wallStarted = stepStartedWallMs.get(stepId);
    const durationMs = wallStarted ? Math.max(0, Date.now() - wallStarted) : null;
    stepStartedWallMs.delete(stepId);
    await my.query(
      `UPDATE workflow_steps SET status = ?, finished_at = ?,
        duration_ms = COALESCE(?, TIMESTAMPDIFF(MICROSECOND, started_at, ?) DIV 1000),
        output_summary_json = ?, warning_json = ?, error_message = ?, updated_at = ? WHERE id = ?`,
      [status || 'success', finished, durationMs, finished,
        outputSummary !== undefined && outputSummary !== null ? JSON.stringify(clip(outputSummary)) : null,
        warnings !== undefined && warnings !== null ? JSON.stringify(clip(warnings)) : null,
        errorMessage ? String(errorMessage).slice(0, 900) : null, finished, stepId]
    );
  }, 'finishWorkflowStep');
}

async function logWorkflowEvent({ engineRunId, workflowStepId, eventType, level = 'info', message, relatedType, relatedId, data }) {
  await safe(() => my.insert('workflow_events', {
    id: my.makeId('evt'), engine_run_id: engineRunId || null, workflow_step_id: workflowStepId || null,
    event_type: eventType, level, message: String(message || '').slice(0, 2000),
    related_type: relatedType || null, related_id: relatedId || null,
    data_json: clip(data), created_at: my.now(),
  }), `logWorkflowEvent(${eventType})`);
}

async function logSourceCollection({ engineRunId, workflowStepId, source, status, httpStatus, itemsFound = 0, itemsInserted = 0, durationMs, errorMessage, warningMessage, sampleTitles }) {
  await safe(() => my.insert('source_collection_logs', {
    id: my.makeId('srclog'), engine_run_id: engineRunId || null, workflow_step_id: workflowStepId || null,
    source_name: source.name || source.sourceName || null, source_group: source.group || source.sourceGroup || null,
    source_type: source.type || source.itemType || null, source_url: (source.url || '').slice(0, 1000) || null,
    query_text: (source.query || '').slice(0, 1000) || null, status,
    http_status: httpStatus ?? null, items_found: itemsFound, items_inserted: itemsInserted,
    duration_ms: durationMs ?? null,
    error_message: errorMessage ? String(errorMessage).slice(0, 900) : null,
    warning_message: warningMessage ? String(warningMessage).slice(0, 900) : null,
    sample_titles_json: clip(sampleTitles), created_at: my.now(),
  }), `logSourceCollection(${source.name || '?'})`);
}

async function logStatusTransition({ entityType, entityId, engineRunId, fromStatus, toStatus, reason, actor = 'engine', data }) {
  await safe(() => my.insert('status_transitions', {
    id: my.makeId('trans'), entity_type: entityType, entity_id: entityId,
    engine_run_id: engineRunId || null, from_status: fromStatus || null, to_status: toStatus,
    reason: reason ? String(reason).slice(0, 900) : null, actor, data_json: clip(data), created_at: my.now(),
  }), `logStatusTransition(${entityType}:${toStatus})`);
}

module.exports = { createWorkflowStep, startWorkflowStep, finishWorkflowStep, logWorkflowEvent, logSourceCollection, logStatusTransition, getTraceFailures };
