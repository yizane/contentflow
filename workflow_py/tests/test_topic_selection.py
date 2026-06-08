from __future__ import annotations

from contentflow.domains.topics.selection import select_topics_for_writing


class FakeDB:
    def __init__(self):
        self.inserts = []
        self.updates = []
        self.candidates = [
            {
                "id": "tc_1",
                "topic": "亚马逊广告 ACoS 怎么降",
                "primary_keyword": "亚马逊广告",
                "secondary_keywords_json": ["ACoS"],
                "category": "ppc-acos",
                "content_angle": "预算重构",
                "business_angle": "降本",
                "source_urls_json": ["https://advertising.amazon.com/blog/post"],
                "score": 92,
                "selection_score": None,
                "content_value_score": 88,
                "value_breakdown_json": {"sellerPainValue": 18, "actionability": 18, "informationGain": 17, "businessFit": 14, "nonRepetition": 13, "sourceSupport": 8},
                "content_type": "operation_guide",
                "business_category": "ppc_acos",
                "topic_cluster": "ppc_intent_keywords",
                "status": "candidate",
            },
            {
                "id": "tc_2",
                "topic": "Prime Day 广告预算怎么调",
                "primary_keyword": "Prime Day 广告",
                "secondary_keywords_json": ["CPC"],
                "category": "ppc-acos",
                "content_angle": "预算调整",
                "business_angle": "降本",
                "source_urls_json": ["https://advertising.amazon.com/blog/post2"],
                "score": 91,
                "selection_score": None,
                "content_value_score": 86,
                "value_breakdown_json": {"sellerPainValue": 17, "actionability": 17, "informationGain": 16, "businessFit": 14, "nonRepetition": 13, "sourceSupport": 9},
                "content_type": "operation_guide",
                "business_category": "ppc_acos",
                "topic_cluster": "ppc_intent_keywords",
                "status": "candidate",
            },
        ]

    def query(self, sql, params=None):
        if "content_value_score IS NULL" in sql:
            return [row for row in self.candidates if row.get("content_value_score") is None]
        if "FROM topic_candidates" in sql:
            return self.candidates
        return []

    def insert(self, table, data):
        self.inserts.append((table, data))

    def update(self, table, data, where_sql, where_params=None):
        self.updates.append((table, data, where_sql, where_params or []))


def test_select_topics_for_writing_selects_one_per_topic_cluster_and_writes_job():
    fake_db = FakeDB()

    result = select_topics_for_writing(limit=2, min_score=80, strategy="balanced", engine_run_id="engine_test", database=fake_db)

    assert result["ok"] is True
    assert result["writingTaskCount"] == 1
    assert result["batchSkipped"][0]["skipReason"] == "批内已选同主题簇 ppc_intent_keywords"
    assert len([1 for table, _ in fake_db.inserts if table == "article_writing_tasks"]) == 1
    assert any(table == "topic_candidates" and data["status"] == "selected" for table, data, *_ in fake_db.updates)


def test_select_topics_for_writing_dry_run_reports_writing_task_count():
    fake_db = FakeDB()

    result = select_topics_for_writing(limit=2, min_score=80, strategy="balanced", dry_run=True, engine_run_id="engine_test", database=fake_db)

    assert result["dryRun"] is True
    assert result["writingTaskCount"] == 1
    assert "jobCount" not in result
    assert "jobsCount" not in result
    assert not fake_db.inserts
