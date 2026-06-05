-- 007_step_key_rename.sql — workflow_steps step_key/step_name 统一为 域:动作 命名
-- 与 scripts/ 文件名（域_动作.js）和 npm script（域:动作）对齐，消除三套命名。
UPDATE workflow_steps SET step_key = 'sources_collect',  step_name = 'sources:collect'  WHERE step_key = 'collect_sources';
UPDATE workflow_steps SET step_key = 'topics_generate',  step_name = 'topics:generate'  WHERE step_key = 'run_topic-generation';
UPDATE workflow_steps SET step_key = 'jobs_create',      step_name = 'jobs:create'      WHERE step_key = 'jobs_create-articles';
UPDATE workflow_steps SET step_key = 'jobs_run',         step_name = 'jobs:run'         WHERE step_key = 'jobs_run-articles';
UPDATE workflow_steps SET step_key = 'factcheck_run',    step_name = 'factcheck:run'    WHERE step_key = 'jobs_run-fact-check';
UPDATE workflow_steps SET step_key = 'score_seo-geo',    step_name = 'score:seo-geo'    WHERE step_key = 'run_seo-geo-score';
-- channels_generate / db_list 命名未变
