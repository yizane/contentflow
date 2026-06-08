-- 012_workflow_step_semantics.sql
-- Workflow step_key 统一改为业务语义；job queue 只是底层实现，不作为主链路节点名。

UPDATE workflow_steps
SET step_key = 'topics_select', step_name = '选题入选与写作排队'
WHERE step_key = 'jobs_create' OR step_name = 'jobs:create';

UPDATE workflow_steps
SET step_key = 'articles_generate', step_name = '文章初稿生成'
WHERE step_key = 'jobs_run' OR step_name = 'jobs:run';

UPDATE workflow_steps
SET step_key = 'articles_factcheck', step_name = '事实核查与来源门禁'
WHERE step_key = 'factcheck_run' OR step_name = 'factcheck:run';

UPDATE workflow_steps
SET step_key = 'article_quality_score', step_name = '文章质量主评分'
WHERE step_key = 'score_article-quality' OR step_name = 'score:article-quality';

UPDATE workflow_steps
SET step_key = 'seo_geo_score', step_name = 'SEO/GEO 辅助评分'
WHERE step_key = 'score_seo-geo' OR step_name = 'score:seo-geo';

UPDATE workflow_steps
SET step_name = '资料采集'
WHERE step_key = 'sources_collect';

UPDATE workflow_steps
SET step_name = '候选主题生成'
WHERE step_key = 'topics_generate';

UPDATE workflow_steps
SET step_name = '渠道改写'
WHERE step_key = 'channels_generate';

UPDATE workflow_steps
SET step_name = '运行摘要'
WHERE step_key = 'db_list';
