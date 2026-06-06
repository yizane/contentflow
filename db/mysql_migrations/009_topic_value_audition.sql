-- 009_topic_value_audition.sql — 内容价值分 + Topic Audition（Phase 12D）
-- content_value_score：独立于 SEO/GEO 的「值不值得写」评分（满分 100）：
--   sellerPainValue 20 / actionability 20 / informationGain 20 / businessFit 15 / nonRepetition 15 / sourceSupport 10
ALTER TABLE topic_candidates ADD COLUMN content_value_score INT;
ALTER TABLE topic_candidates ADD COLUMN value_breakdown_json JSON;

CREATE INDEX idx_topic_candidates_content_value ON topic_candidates(content_value_score);

-- 选题压力测试：模拟未来 N 轮选题（不生成文章）
CREATE TABLE IF NOT EXISTS topic_audition_runs (
  id VARCHAR(64) PRIMARY KEY,
  engine_run_id VARCHAR(64),
  rounds INT NOT NULL,
  limit_per_round INT NOT NULL,
  policy_json JSON,
  summary_json JSON,
  status VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS topic_audition_items (
  id VARCHAR(64) PRIMARY KEY,
  audition_run_id VARCHAR(64) NOT NULL,
  round_no INT NOT NULL,
  topic_candidate_id VARCHAR(64),
  topic VARCHAR(512),
  content_type VARCHAR(64),
  business_category VARCHAR(64),
  topic_cluster VARCHAR(128),
  primary_keyword VARCHAR(255),
  raw_score INT,
  content_value_score INT,
  selection_score INT,
  decision VARCHAR(64) NOT NULL,
  decision_reason TEXT,
  portfolio_debug_json JSON,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_topic_audition_items_run (audition_run_id),
  INDEX idx_topic_audition_items_decision (decision),
  INDEX idx_topic_audition_items_category (business_category),
  INDEX idx_topic_audition_items_cluster (topic_cluster)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
