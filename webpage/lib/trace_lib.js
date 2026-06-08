// trace_lib.js — Viewer-side audit helper for manual review actions.
const my = require('./mysql_lib');

function clip(value, max = 2000) {
  if (value === null || value === undefined) return null;
  const text = JSON.stringify(value);
  if (text.length <= max) return value;
  return { _truncated: true, preview: text.slice(0, max) };
}

async function logStatusTransition({ entityType, entityId, engineRunId, fromStatus, toStatus, reason, actor = 'viewer', data }) {
  await my.insert('status_transitions', {
    id: my.makeId('trans'),
    entity_type: entityType,
    entity_id: entityId,
    engine_run_id: engineRunId || null,
    from_status: fromStatus || null,
    to_status: toStatus,
    reason: reason ? String(reason).slice(0, 900) : null,
    actor,
    data_json: clip(data),
    created_at: my.now(),
  });
}

module.exports = { logStatusTransition };
