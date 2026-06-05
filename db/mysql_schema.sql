-- Flyfus Content Agent — MySQL schema（唯一正式 schema，MySQL 是唯一运行时数据源）
-- 约定：ID VARCHAR(64)；时间 DATETIME(3)；JSON 用 MySQL JSON；长正文 LONGTEXT；
--       不强制外键（应用层一致性）；ENGINE=InnoDB utf8mb4。

CREATE TABLE IF NOT EXISTS schema_migrations (
  id VARCHAR(128) PRIMARY KEY,
  executed_at DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS engine_runs (
  id VARCHAR(64) PRIMARY KEY,
  run_type VARCHAR(64) NOT NULL,
  status VARCHAR(64) NOT NULL,
  topics_collected INT DEFAULT 0,
  topics_selected INT DEFAULT 0,
  articles_generated INT DEFAULT 0,
  articles_validated INT DEFAULT 0,
  fact_checks_completed INT DEFAULT 0,
  channel_outputs_generated INT DEFAULT 0,
  started_at DATETIME(3) NOT NULL,
  finished_at DATETIME(3),
  summary_json JSON,
  error_message TEXT,
  daily_key VARCHAR(10),
  run_scope VARCHAR(64) DEFAULT 'manual',
  run_mode VARCHAR(64) DEFAULT 'start',
  is_active BOOLEAN DEFAULT TRUE,
  superseded_by VARCHAR(64),
  triggered_by VARCHAR(128),
  trigger_source VARCHAR(64),
  INDEX idx_engine_runs_started (started_at),
  INDEX idx_engine_runs_status (status),
  INDEX idx_engine_runs_daily_key (daily_key),
  INDEX idx_engine_runs_scope_active (run_scope, is_active),
  INDEX idx_engine_runs_daily_scope (daily_key, run_scope)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS source_items (
  id VARCHAR(64) PRIMARY KEY,
  engine_run_id VARCHAR(64),
  source_name VARCHAR(255),
  source_group VARCHAR(128),
  source_url VARCHAR(1024),
  source_type VARCHAR(64),
  source_trust VARCHAR(64),
  title VARCHAR(512),
  summary TEXT,
  content_text LONGTEXT,
  retrieved_at DATETIME(3),
  as_of VARCHAR(32),
  raw_json JSON,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_source_items_run (engine_run_id),
  INDEX idx_source_items_url (source_url(255)),
  INDEX idx_source_items_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS topic_candidates (
  id VARCHAR(64) PRIMARY KEY,
  engine_run_id VARCHAR(64),
  topic VARCHAR(512) NOT NULL,
  normalized_topic VARCHAR(512),
  primary_keyword VARCHAR(255),
  secondary_keywords_json JSON,
  category VARCHAR(128),
  content_angle TEXT,
  business_angle TEXT,
  source_item_ids_json JSON,
  source_urls_json JSON,
  score INT,
  priority VARCHAR(16),
  status VARCHAR(64) NOT NULL,
  reject_reason TEXT,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  INDEX idx_topic_candidates_status (status),
  INDEX idx_topic_candidates_score (score),
  INDEX idx_topic_candidates_norm (normalized_topic(191)),
  INDEX idx_topic_candidates_kw (primary_keyword)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS article_jobs (
  id VARCHAR(64) PRIMARY KEY,
  engine_run_id VARCHAR(64),
  topic_candidate_id VARCHAR(64),
  topic VARCHAR(512),
  primary_keyword VARCHAR(255),
  secondary_keywords_json JSON,
  category VARCHAR(128),
  content_angle TEXT,
  business_angle TEXT,
  source_urls_json JSON,
  strategy VARCHAR(64),
  status VARCHAR(64) NOT NULL,            -- pending | running | generated | failed | cancelled
  error_message TEXT,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  INDEX idx_article_jobs_status (status),
  INDEX idx_article_jobs_run (engine_run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS articles (
  id VARCHAR(64) PRIMARY KEY,
  engine_run_id VARCHAR(64),
  topic_candidate_id VARCHAR(64),
  current_version_id VARCHAR(64),
  title VARCHAR(512) NOT NULL,
  slug VARCHAR(255),
  primary_keyword VARCHAR(255),
  secondary_keywords_json JSON,
  status VARCHAR(64) NOT NULL,
  quality_score INT,
  seo_score INT,
  geo_score INT,
  publish_recommendation VARCHAR(64),
  fact_overall_risk VARCHAR(64),
  fact_publish_readiness VARCHAR(64),
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  INDEX idx_articles_status (status),
  INDEX idx_articles_slug (slug),
  INDEX idx_articles_created (created_at),
  INDEX idx_articles_kw (primary_keyword)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS article_versions (
  id VARCHAR(64) PRIMARY KEY,
  article_id VARCHAR(64) NOT NULL,
  engine_run_id VARCHAR(64),
  article_job_id VARCHAR(64),
  topic_candidate_id VARCHAR(64),
  model_provider VARCHAR(64),
  model_name VARCHAR(128),
  version_label VARCHAR(64),
  generation_mode VARCHAR(64),
  strategy VARCHAR(64),
  title VARCHAR(512),
  slug VARCHAR(255),
  status VARCHAR(64) NOT NULL,
  article_markdown LONGTEXT,
  article_json JSON,
  quality_json JSON,
  fact_check_json JSON,
  source_resolution_json JSON,
  seo_score_json JSON,
  geo_score_json JSON,
  dual_quality_json JSON,
  quality_score INT,
  seo_score INT,
  geo_score INT,
  publish_recommendation VARCHAR(64),
  fact_publish_readiness VARCHAR(64),
  content_sha256 VARCHAR(128),
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  INDEX idx_article_versions_article (article_id),
  INDEX idx_article_versions_status (status),
  INDEX idx_article_versions_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS quality_reports (
  id VARCHAR(64) PRIMARY KEY,
  article_id VARCHAR(64) NOT NULL,
  article_version_id VARCHAR(64),
  score INT NOT NULL,
  publish_recommendation VARCHAR(64),
  facts_score INT,
  issues_json JSON,
  required_fixes_json JSON,
  raw_json JSON,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_quality_reports_article (article_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS fact_checks (
  id VARCHAR(64) PRIMARY KEY,
  article_id VARCHAR(64) NOT NULL,
  article_version_id VARCHAR(64),
  overall_risk VARCHAR(64),
  publish_readiness VARCHAR(64),
  claims_count INT,
  high_risk_count INT,
  medium_risk_count INT,
  source_needed_count INT,
  must_fix_count INT,
  must_fix_json JSON,
  raw_json JSON,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_fact_checks_article (article_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS source_resolutions (
  id VARCHAR(64) PRIMARY KEY,
  article_id VARCHAR(64) NOT NULL,
  article_version_id VARCHAR(64),
  fact_check_id VARCHAR(64),
  claim_text TEXT NOT NULL,
  claim_category VARCHAR(128),
  risk VARCHAR(64),
  action VARCHAR(64),
  recommended_source_group VARCHAR(128),
  resolved_status VARCHAR(64) NOT NULL,
  source_url VARCHAR(1024),
  source_title VARCHAR(512),
  source_name VARCHAR(255),
  source_type VARCHAR(64),
  source_trust VARCHAR(64),
  evidence_summary TEXT,
  suggested_rewrite TEXT,
  notes TEXT,
  raw_json JSON,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  INDEX idx_source_resolutions_article (article_id),
  INDEX idx_source_resolutions_status (resolved_status),
  INDEX idx_source_resolutions_risk (risk)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS channel_outputs (
  id VARCHAR(64) PRIMARY KEY,
  article_id VARCHAR(64) NOT NULL,
  article_version_id VARCHAR(64),
  channel VARCHAR(64) NOT NULL,
  title VARCHAR(512),
  content_markdown LONGTEXT,
  content_json JSON,
  status VARCHAR(64) NOT NULL,
  content_sha256 VARCHAR(128),
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  INDEX idx_channel_outputs_article (article_id),
  INDEX idx_channel_outputs_channel (channel)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS seo_geo_scores (
  id VARCHAR(64) PRIMARY KEY,
  article_id VARCHAR(64) NOT NULL,
  article_version_id VARCHAR(64),
  engine_run_id VARCHAR(64),
  strategy VARCHAR(64),
  overall_score INT,
  seo_score INT,
  geo_score INT,
  fact_score INT,
  business_fit_score INT,
  readability_score INT,
  recommendation VARCHAR(64),
  seo_json JSON,
  geo_json JSON,
  dual_json JSON,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_seo_geo_scores_article (article_id),
  INDEX idx_seo_geo_scores_strategy (strategy),
  INDEX idx_seo_geo_scores_overall (overall_score)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS model_runs (
  id VARCHAR(64) PRIMARY KEY,
  engine_run_id VARCHAR(64),
  article_id VARCHAR(64),
  article_version_id VARCHAR(64),
  task_type VARCHAR(64) NOT NULL,
  model_provider VARCHAR(64),
  model_name VARCHAR(128),
  openclaw_session_key VARCHAR(255),
  task_prompt LONGTEXT,
  raw_response LONGTEXT,
  parsed_output_json JSON,
  status VARCHAR(64) NOT NULL,
  started_at DATETIME(3) NOT NULL,
  finished_at DATETIME(3),
  error_message TEXT,
  raw_summary_json JSON,
  INDEX idx_model_runs_run (engine_run_id),
  INDEX idx_model_runs_task_type (task_type),
  INDEX idx_model_runs_status (status),
  INDEX idx_model_runs_article (article_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS publish_packages (
  id VARCHAR(64) PRIMARY KEY,
  article_id VARCHAR(64) NOT NULL,
  article_version_id VARCHAR(64),
  slug VARCHAR(255),
  status VARCHAR(64) NOT NULL,
  metadata_json JSON,
  readme_markdown LONGTEXT,
  article_markdown LONGTEXT,
  article_json JSON,
  quality_json JSON,
  fact_check_json JSON,
  source_resolution_json JSON,
  channels_json JSON,
  ready_for_publish_package BOOLEAN DEFAULT FALSE,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  INDEX idx_publish_packages_article (article_id),
  INDEX idx_publish_packages_slug (slug),
  INDEX idx_publish_packages_ready (ready_for_publish_package)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS review_actions (
  id VARCHAR(64) PRIMARY KEY,
  article_id VARCHAR(64) NOT NULL,
  before_status VARCHAR(64),
  after_status VARCHAR(64),
  action VARCHAR(64),
  note TEXT,
  actor VARCHAR(128),
  dry_run BOOLEAN DEFAULT FALSE,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_review_actions_article (article_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS engine_reports (
  id VARCHAR(64) PRIMARY KEY,
  engine_run_id VARCHAR(64),
  report_json JSON,
  report_markdown LONGTEXT,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_engine_reports_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===== Workflow Trace =====

CREATE TABLE IF NOT EXISTS workflow_steps (
  id VARCHAR(64) PRIMARY KEY,
  engine_run_id VARCHAR(64),
  step_key VARCHAR(128) NOT NULL,
  step_name VARCHAR(255),
  step_order INT,
  status VARCHAR(64) NOT NULL,          -- pending | running | success | warning | failed | skipped
  started_at DATETIME(3) NOT NULL,
  finished_at DATETIME(3),
  duration_ms INT,
  input_summary_json JSON,
  output_summary_json JSON,
  warning_json JSON,
  error_message TEXT,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  INDEX idx_workflow_steps_engine_run_id (engine_run_id),
  INDEX idx_workflow_steps_status (status),
  INDEX idx_workflow_steps_step_key (step_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS source_collection_logs (
  id VARCHAR(64) PRIMARY KEY,
  engine_run_id VARCHAR(64),
  workflow_step_id VARCHAR(64),
  source_name VARCHAR(255),
  source_group VARCHAR(128),
  source_type VARCHAR(64),
  source_url VARCHAR(1024),
  query_text VARCHAR(1024),
  status VARCHAR(64) NOT NULL,          -- success | partial | failed | skipped
  http_status INT,
  items_found INT DEFAULT 0,
  items_inserted INT DEFAULT 0,
  duration_ms INT,
  error_message TEXT,
  warning_message TEXT,
  sample_titles_json JSON,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_source_collection_logs_engine_run_id (engine_run_id),
  INDEX idx_source_collection_logs_status (status),
  INDEX idx_source_collection_logs_source_group (source_group),
  INDEX idx_source_collection_logs_source_name (source_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS workflow_events (
  id VARCHAR(64) PRIMARY KEY,
  engine_run_id VARCHAR(64),
  workflow_step_id VARCHAR(64),
  event_type VARCHAR(128) NOT NULL,
  level VARCHAR(32) NOT NULL,           -- debug | info | warning | error
  message TEXT NOT NULL,
  related_type VARCHAR(128),
  related_id VARCHAR(64),
  data_json JSON,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_workflow_events_engine_run_id (engine_run_id),
  INDEX idx_workflow_events_workflow_step_id (workflow_step_id),
  INDEX idx_workflow_events_level (level),
  INDEX idx_workflow_events_event_type (event_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS status_transitions (
  id VARCHAR(64) PRIMARY KEY,
  entity_type VARCHAR(128) NOT NULL,
  entity_id VARCHAR(64) NOT NULL,
  engine_run_id VARCHAR(64),
  from_status VARCHAR(64),
  to_status VARCHAR(64) NOT NULL,
  reason TEXT,
  actor VARCHAR(128),
  data_json JSON,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_status_transitions_entity (entity_type, entity_id),
  INDEX idx_status_transitions_engine_run_id (engine_run_id),
  INDEX idx_status_transitions_to_status (to_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===== Run Actions =====

CREATE TABLE IF NOT EXISTS run_actions (
  id VARCHAR(64) PRIMARY KEY,
  engine_run_id VARCHAR(64),
  daily_key VARCHAR(10),
  action VARCHAR(64) NOT NULL,        -- start_daily | retry_daily | rebuild_daily | force_daily | generate_report
  actor VARCHAR(128),
  trigger_source VARCHAR(64),
  request_json JSON,
  result_json JSON,
  status VARCHAR(64) NOT NULL,        -- accepted | rejected | running | success | failed
  error_message TEXT,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_run_actions_daily_key (daily_key),
  INDEX idx_run_actions_engine_run_id (engine_run_id),
  INDEX idx_run_actions_action (action)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===== Config in DB =====

CREATE TABLE IF NOT EXISTS config_keywords (
  id VARCHAR(64) PRIMARY KEY,
  keyword VARCHAR(255) NOT NULL,
  cluster VARCHAR(128),
  intent VARCHAR(64),
  priority VARCHAR(16),
  stage VARCHAR(64),
  business_angle VARCHAR(255),
  enabled TINYINT DEFAULT 1,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uniq_config_keywords_keyword (keyword),
  INDEX idx_config_keywords_priority (priority),
  INDEX idx_config_keywords_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS config_sources (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  group_name VARCHAR(128),
  type VARCHAR(64),
  category VARCHAR(128),
  priority VARCHAR(32),
  url VARCHAR(1024),
  site_url VARCHAR(1024),
  language VARCHAR(16),
  requires_auth TINYINT DEFAULT 0,
  freshness VARCHAR(64),
  query_text VARCHAR(1024),
  notes TEXT,
  extra_json JSON,
  enabled TINYINT DEFAULT 1,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uniq_config_sources_name (name),
  INDEX idx_config_sources_group (group_name),
  INDEX idx_config_sources_type (type),
  INDEX idx_config_sources_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 文档型配置：YAML 策略 / prompts / schemas
CREATE TABLE IF NOT EXISTS app_configs (
  config_key VARCHAR(191) PRIMARY KEY,   -- internal_claims | production_policy | models | sources_yaml | prompt:<file> | schema:<file>
  config_type VARCHAR(64) NOT NULL,      -- yaml_doc | prompt | schema
  content LONGTEXT NOT NULL,
  content_sha256 VARCHAR(128),
  version INT DEFAULT 1,
  updated_by VARCHAR(128),               -- file-sync | web | ...
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  INDEX idx_app_configs_type (config_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
