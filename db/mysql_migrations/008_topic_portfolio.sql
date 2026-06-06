-- 008_topic_portfolio.sql — Topic Portfolio Balancer（Phase 12B）
-- raw_score：AI 选题质量分（保留原 score 语义）；selection_score：组合调整后的选择分。
-- selection_status：eligible / selected / deferred / skipped_quota / skipped_duplicate / skipped_low_score / skipped_recent_keyword
-- deferred：高分但近期主题饱和的候选（窗口过后自动回池），与 rejected（低质/风险/无业务价值）语义区分。
ALTER TABLE topic_candidates ADD COLUMN raw_score INT;
ALTER TABLE topic_candidates ADD COLUMN selection_score INT;
ALTER TABLE topic_candidates ADD COLUMN selection_status VARCHAR(64);
ALTER TABLE topic_candidates ADD COLUMN selection_skip_reason TEXT;
ALTER TABLE topic_candidates ADD COLUMN deferred_until DATETIME(3);
ALTER TABLE topic_candidates ADD COLUMN portfolio_debug_json JSON;

CREATE INDEX idx_topic_candidates_selection_status ON topic_candidates(selection_status);
CREATE INDEX idx_topic_candidates_selection_score ON topic_candidates(selection_score);
CREATE INDEX idx_topic_candidates_deferred_until ON topic_candidates(deferred_until);

-- 历史数据：raw_score 回填为原 score
UPDATE topic_candidates SET raw_score = score WHERE raw_score IS NULL;
