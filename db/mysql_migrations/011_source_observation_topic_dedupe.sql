-- 011_source_observation_topic_dedupe.sql
-- Lean v1: canonical source identity, daily observations, mechanical topic signals,
-- and topic dedupe audit. This migration only creates new tables.

CREATE TABLE IF NOT EXISTS source_canonical_items (
  canonical_url_hash CHAR(64) PRIMARY KEY,
  canonical_url VARCHAR(1024) NOT NULL,
  source_item_id VARCHAR(64) NOT NULL,
  first_seen_at DATETIME(3) NOT NULL,
  last_seen_at DATETIME(3) NOT NULL,
  seen_count INT NOT NULL DEFAULT 1,
  source_count INT NOT NULL DEFAULT 1,
  lane VARCHAR(16) NOT NULL DEFAULT 'knowledge',
  usage_status VARCHAR(16) NOT NULL DEFAULT 'unused',
  used_at DATETIME(3),
  used_by_article_id VARCHAR(64),
  times_in_prompt INT NOT NULL DEFAULT 0,
  reactivated_at DATETIME(3),
  content_fingerprint CHAR(64),
  last_engine_run_id VARCHAR(64),
  last_observation_id VARCHAR(64),
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  INDEX idx_source_canonical_source_item (source_item_id),
  INDEX idx_source_canonical_last_seen (last_seen_at),
  INDEX idx_source_canonical_lane_usage (lane, usage_status),
  INDEX idx_source_canonical_reactivated (reactivated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS source_observations (
  id VARCHAR(64) PRIMARY KEY,
  engine_run_id VARCHAR(64),
  daily_key VARCHAR(10),
  source_item_id VARCHAR(64),
  canonical_url_hash CHAR(64),
  source_name VARCHAR(255),
  source_group VARCHAR(128),
  source_url VARCHAR(1024),
  canonical_url VARCHAR(1024),
  source_lane VARCHAR(16),
  title VARCHAR(512),
  summary TEXT,
  published_at VARCHAR(64),
  retrieved_at DATETIME(3) NOT NULL,
  observation_status VARCHAR(64) NOT NULL,
  duplicate_reason TEXT,
  raw_json JSON,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_source_observations_run (engine_run_id),
  INDEX idx_source_observations_daily (daily_key),
  INDEX idx_source_observations_hash (canonical_url_hash),
  INDEX idx_source_observations_source_item (source_item_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS topic_signals (
  id VARCHAR(64) PRIMARY KEY,
  engine_run_id VARCHAR(64),
  source_observation_id VARCHAR(64),
  source_item_id VARCHAR(64),
  topic_candidate_id VARCHAR(64),
  signal_topic VARCHAR(512),
  status VARCHAR(64) NOT NULL,
  score INT,
  reason TEXT,
  raw_json JSON,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_topic_signals_run (engine_run_id),
  INDEX idx_topic_signals_observation (source_observation_id),
  INDEX idx_topic_signals_source_item (source_item_id),
  INDEX idx_topic_signals_candidate (topic_candidate_id),
  INDEX idx_topic_signals_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS topic_dedupe_records (
  id VARCHAR(64) PRIMARY KEY,
  engine_run_id VARCHAR(64),
  topic_candidate_id VARCHAR(64),
  duplicate_of_topic_candidate_id VARCHAR(64),
  candidate_topic VARCHAR(512) NOT NULL,
  normalized_topic VARCHAR(512),
  primary_keyword VARCHAR(255),
  decision VARCHAR(64) NOT NULL,
  similarity DECIMAL(5,4),
  reason TEXT,
  raw_candidate_json JSON,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_topic_dedupe_run (engine_run_id),
  INDEX idx_topic_dedupe_decision (decision),
  INDEX idx_topic_dedupe_kw (primary_keyword),
  INDEX idx_topic_dedupe_candidate (topic_candidate_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
