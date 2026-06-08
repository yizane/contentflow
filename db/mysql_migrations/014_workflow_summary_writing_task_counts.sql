-- 014_workflow_summary_writing_task_counts.sql
-- 清理 topics_select 历史 output_summary_json 中的 jobCount/jobsCount 旧字段。

UPDATE workflow_steps
SET output_summary_json = JSON_REMOVE(
  JSON_SET(
    output_summary_json,
    '$.writingTaskCount',
    COALESCE(
      JSON_EXTRACT(output_summary_json, '$.writingTaskCount'),
      JSON_EXTRACT(output_summary_json, '$.jobCount'),
      JSON_EXTRACT(output_summary_json, '$.jobsCount')
    )
  ),
  '$.jobCount',
  '$.jobsCount'
)
WHERE step_key = 'topics_select'
  AND output_summary_json IS NOT NULL
  AND (
    JSON_EXTRACT(output_summary_json, '$.jobCount') IS NOT NULL
    OR JSON_EXTRACT(output_summary_json, '$.jobsCount') IS NOT NULL
  );
