-- 006_content_taxonomy.sql — 内容三层分类（content_type / business_category / topic_cluster）
-- source_group 表示来源分组，与内容分类是两套体系。
-- 分类由规则 + AI（content_classifier）共同产出，结果写实体表字段 + content_classifications 审计表。

-- 1) source_items
ALTER TABLE source_items ADD COLUMN content_type VARCHAR(64);
ALTER TABLE source_items ADD COLUMN business_category VARCHAR(64);
ALTER TABLE source_items ADD COLUMN topic_cluster VARCHAR(128);
ALTER TABLE source_items ADD COLUMN classification_confidence DECIMAL(5,4);
ALTER TABLE source_items ADD COLUMN classification_reason TEXT;

CREATE INDEX idx_source_items_content_type ON source_items(content_type);
CREATE INDEX idx_source_items_business_category ON source_items(business_category);
CREATE INDEX idx_source_items_topic_cluster ON source_items(topic_cluster);

-- 2) topic_candidates
ALTER TABLE topic_candidates ADD COLUMN content_type VARCHAR(64);
ALTER TABLE topic_candidates ADD COLUMN business_category VARCHAR(64);
ALTER TABLE topic_candidates ADD COLUMN topic_cluster VARCHAR(128);
ALTER TABLE topic_candidates ADD COLUMN classification_confidence DECIMAL(5,4);
ALTER TABLE topic_candidates ADD COLUMN classification_reason TEXT;

CREATE INDEX idx_topic_candidates_content_type ON topic_candidates(content_type);
CREATE INDEX idx_topic_candidates_business_category ON topic_candidates(business_category);
CREATE INDEX idx_topic_candidates_topic_cluster ON topic_candidates(topic_cluster);

-- 3) article_jobs（任务透传分类，文章生成时落到 articles / article_versions）
ALTER TABLE article_jobs ADD COLUMN content_type VARCHAR(64);
ALTER TABLE article_jobs ADD COLUMN business_category VARCHAR(64);
ALTER TABLE article_jobs ADD COLUMN topic_cluster VARCHAR(128);

CREATE INDEX idx_article_jobs_business_category ON article_jobs(business_category);

-- 4) articles
ALTER TABLE articles ADD COLUMN content_type VARCHAR(64);
ALTER TABLE articles ADD COLUMN business_category VARCHAR(64);
ALTER TABLE articles ADD COLUMN topic_cluster VARCHAR(128);

CREATE INDEX idx_articles_content_type ON articles(content_type);
CREATE INDEX idx_articles_business_category ON articles(business_category);
CREATE INDEX idx_articles_topic_cluster ON articles(topic_cluster);

-- 5) article_versions
ALTER TABLE article_versions ADD COLUMN content_type VARCHAR(64);
ALTER TABLE article_versions ADD COLUMN business_category VARCHAR(64);
ALTER TABLE article_versions ADD COLUMN topic_cluster VARCHAR(128);

CREATE INDEX idx_article_versions_content_type ON article_versions(content_type);
CREATE INDEX idx_article_versions_business_category ON article_versions(business_category);

-- 6) 分类过程审计表
CREATE TABLE IF NOT EXISTS content_classifications (
  id VARCHAR(64) PRIMARY KEY,
  entity_type VARCHAR(64) NOT NULL,
  entity_id VARCHAR(64) NOT NULL,
  content_type VARCHAR(64),
  business_category VARCHAR(64),
  topic_cluster VARCHAR(128),
  confidence DECIMAL(5,4),
  reason TEXT,
  classifier_type VARCHAR(64),
  model_run_id VARCHAR(64),
  raw_json JSON,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_content_classifications_entity (entity_type, entity_id),
  INDEX idx_content_classifications_content_type (content_type),
  INDEX idx_content_classifications_business_category (business_category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
