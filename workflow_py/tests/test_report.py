from __future__ import annotations

import json
from datetime import datetime, timedelta

from contentflow.ops import report


class ObservabilityDB:
    def __init__(self):
        self.run_id = "engine_test"
        self.started = datetime(2026, 6, 8, 9, 0, 0)
        self.inserts = []

    def query(self, sql, params=None):
        params = params or []
        if "FROM engine_runs WHERE id" in sql:
            return [{"id": self.run_id, "daily_key": "2026-06-08", "status": "failed", "started_at": self.started, "finished_at": self.started + timedelta(minutes=5)}]
        if "FROM workflow_steps" in sql:
            return [
                {"id": "step_topics", "step_key": "topics_generate", "step_name": "topics:generate", "step_order": 1, "status": "success", "started_at": self.started, "finished_at": self.started + timedelta(minutes=2), "duration_ms": 120000, "input_summary_json": {"round": 1}, "output_summary_json": {"round": 1}},
                {"id": "step_articles", "step_key": "articles_generate", "step_name": "文章初稿生成", "step_order": 2, "status": "success", "started_at": self.started + timedelta(minutes=2), "finished_at": self.started + timedelta(minutes=5), "duration_ms": 180000, "input_summary_json": {"round": 1, "command": "articles:generate"}, "output_summary_json": {"round": 1}},
            ]
        if "FROM model_runs" in sql:
            return [
                {"id": "mrun_topic", "task_type": "topic_generation", "status": "succeeded", "started_at": self.started + timedelta(seconds=10), "finished_at": self.started + timedelta(seconds=70), "raw_summary_json": {"durationMs": 60000, "usage": {"inputTokens": 1000, "outputTokens": 500, "totalTokens": 1500}}, "error_message": None},
                {"id": "mrun_article", "task_type": "article_generation", "status": "succeeded", "started_at": self.started + timedelta(minutes=2, seconds=10), "finished_at": self.started + timedelta(minutes=4), "raw_summary_json": json.dumps({"durationMs": 110000, "usage": {"inputTokens": 800, "outputTokens": 1200, "totalTokens": 2000}}), "error_message": None},
            ]
        return []

    def insert(self, table, data):
        self.inserts.append((table, data))


def test_build_run_observability_groups_model_usage_by_step_window():
    db = ObservabilityDB()

    result = report.build_run_observability(run_id="engine_test", database=db)

    assert result["runId"] == "engine_test"
    assert result["totals"]["totalTokens"] == 3500
    assert result["totals"]["modelCalls"] == 2
    assert result["steps"][0]["stepKey"] == "topics_generate"
    assert result["steps"][0]["displayName"] == "候选主题生成"
    assert result["steps"][0]["totalTokens"] == 1500
    assert result["steps"][1]["stepKey"] == "articles_generate"
    assert result["steps"][1]["displayName"] == "文章初稿生成"
    assert "生成文章" in result["steps"][1]["purpose"]
    assert result["steps"][1]["totalTokens"] == 2000
    assert result["unmatchedModelRuns"] == []
