-- 010_article_quality_visual.sql — Article Quality 主评分 + Visual Plan（Phase 13）
-- 原则：article_quality_score 是主评分（>=80 才能进终审）；SEO/GEO 是辅助建议线；
-- visual_plan 只存规划（brief/alt/caption/prompt），不存图片二进制，不自动生成图片。

CREATE TABLE IF NOT EXISTS article_quality_scores (
  id VARCHAR(64) PRIMARY KEY,
  article_id VARCHAR(64) NOT NULL,
  article_version_id VARCHAR(64),
  engine_run_id VARCHAR(64),
  article_quality_score INT,
  seller_pain_fit INT,
  actionability INT,
  information_gain INT,
  originality INT,
  clarity INT,
  evidence_use INT,
  business_usefulness INT,
  recommendation VARCHAR(64),
  raw_json JSON,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_article_quality_scores_article_id (article_id),
  INDEX idx_article_quality_scores_score (article_quality_score),
  INDEX idx_article_quality_scores_recommendation (recommendation)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE article_versions ADD COLUMN article_quality_json JSON;
ALTER TABLE article_versions ADD COLUMN article_quality_score INT;
ALTER TABLE article_versions ADD COLUMN visual_plan_json JSON;

ALTER TABLE articles ADD COLUMN article_quality_score INT;
ALTER TABLE articles ADD COLUMN visual_plan_json JSON;

CREATE INDEX idx_articles_article_quality ON articles(article_quality_score);

ALTER TABLE publish_packages ADD COLUMN visual_plan_json JSON;
ALTER TABLE publish_packages ADD COLUMN article_quality_json JSON;
