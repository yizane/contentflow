from __future__ import annotations

from contentflow.domains.topics.generation import generate_topics


def candidate(index: int, url="https://www.amz123.com/kx/1"):
    return {
        "topic": f"亚马逊广告 ACoS 怎么降 {index}",
        "primaryKeyword": "亚马逊广告",
        "secondaryKeywords": ["ACoS"],
        "category": "ppc-acos",
        "contentType": "operation_guide",
        "businessCategory": "ppc_acos",
        "topicCluster": "ppc_intent_keywords",
        "contentAngle": "Prime Day 前广告预算重构",
        "businessAngle": "降低旺季烧钱风险",
        "sourceUrls": [url],
        "score": 90,
        "contentValueScore": 88,
        "sellerPainValue": 18,
        "actionability": 18,
        "informationGain": 18,
        "businessFit": 14,
        "nonRepetition": 12,
        "sourceSupport": 8,
        "priority": "P0",
        "status": "candidate",
        "reason": "可执行",
        "rejectRisk": "低",
    }


class FakeDB:
    def __init__(self):
        self.inserts = []
        self.updates = []
        self.queries = []
        self.source_row = {
            "id": "source_1",
            "source_group": "news",
            "source_name": "AMZ123 快讯",
            "source_url": "https://www.amz123.com/kx/1",
            "title": "亚马逊广告 ACoS 上涨",
            "summary": "亚马逊卖家 Prime Day 前广告成本上涨",
            "content_type": "news_flash",
            "business_category": "ppc_acos",
            "canonical_url_hash": "hash_1",
            "lane": "news",
            "first_seen_at": "2026-06-01 00:00:00.000",
            "usage_status": "unused",
            "times_in_prompt": 0,
            "observation_count": 1,
            "observation_ids_json": ["obs_1"],
        }

    def query(self, sql, params=None):
        self.queries.append((sql, params or []))
        if "FROM source_observations" in sql and "sci.lane = 'news'" in sql:
            return [self.source_row]
        if "FROM source_observations" in sql and "sci.lane = 'policy'" in sql:
            return []
        if "FROM source_canonical_items sci" in sql and "sci.lane = 'knowledge'" in sql:
            return []
        if "SELECT title FROM articles" in sql:
            return []
        if "SELECT id, title AS topic" in sql:
            return []
        if "SELECT id, topic, normalized_topic" in sql:
            return []
        if "SELECT COUNT(*) c FROM articles WHERE primary_keyword" in sql:
            return [{"c": 0}]
        if "SELECT source_item_id FROM source_canonical_items" in sql:
            return []
        if "SELECT * FROM config_sources" in sql:
            return []
        return []

    def insert(self, table, data):
        self.inserts.append((table, data))

    def update(self, table, data, where_sql, where_params=None):
        self.updates.append((table, data, where_sql, where_params or []))


def test_generate_topics_writes_candidates_dedupe_records_and_signals():
    fake_db = FakeDB()

    def fake_call_agent(**_kwargs):
        return {"ok": True, "data": {"generatedAt": "2026-06-01", "candidates": [candidate(i) for i in range(5)]}}

    result = generate_topics(engine_run_id="engine_test", database=fake_db, call_agent=fake_call_agent)

    assert result["ok"] is True
    assert result["inserted"] == 5
    assert result["sourceScope"] == "engine_run_lanes"
    assert len([1 for table, _ in fake_db.inserts if table == "topic_candidates"]) == 5
    assert len([1 for table, _ in fake_db.inserts if table == "topic_dedupe_records"]) == 5
    assert len([1 for table, _ in fake_db.inserts if table == "content_classifications"]) == 5
    assert result["topicSignals"]["mergedIntoCandidate"] == 5
