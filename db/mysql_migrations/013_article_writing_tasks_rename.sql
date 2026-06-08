-- 013_article_writing_tasks_rename.sql
-- article_jobs 是旧的通用命名；改为 article_writing_tasks，明确这是文章写作任务队列。

SET @old_task_table_exists := (
  SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'article_jobs'
);

SET @new_task_table_exists := (
  SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'article_writing_tasks'
);

SET @rename_task_table_sql := IF(
  @old_task_table_exists = 1 AND @new_task_table_exists = 0,
  'RENAME TABLE article_jobs TO article_writing_tasks',
  'SELECT 1'
);

PREPARE rename_task_table_stmt FROM @rename_task_table_sql;
EXECUTE rename_task_table_stmt;
DEALLOCATE PREPARE rename_task_table_stmt;

SET @old_task_column_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'article_versions' AND column_name = 'article_job_id'
);

SET @new_task_column_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'article_versions' AND column_name = 'article_writing_task_id'
);

SET @rename_task_column_sql := IF(
  @old_task_column_exists = 1 AND @new_task_column_exists = 0,
  'ALTER TABLE article_versions CHANGE COLUMN article_job_id article_writing_task_id VARCHAR(64)',
  'SELECT 1'
);

PREPARE rename_task_column_stmt FROM @rename_task_column_sql;
EXECUTE rename_task_column_stmt;
DEALLOCATE PREPARE rename_task_column_stmt;
