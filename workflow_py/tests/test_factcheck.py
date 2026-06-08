from __future__ import annotations

from contentflow.domains.production.factcheck import factcheck_articles_for_review_gate


class FakeDB:
    def __init__(self):
        self.inserts = []
        self.updates = []
        self.article = {
            "id": "article_1",
            "engine_run_id": "engine_test",
            "status": "article_validated",
            "quality_score": 86,
            "article_quality_score": 84,
            "publish_recommendation": "publish",
        }
        self.version = {
            "id": "ver_1",
            "article_id": "article_1",
            "article_markdown": "# 标题\n\n正文",
            "quality_json": {"score": 86, "publishRecommendation": "publish"},
        }

    def query(self, sql, params=None):
        if "FROM articles WHERE status" in sql:
            return [self.article]
        if "FROM article_versions" in sql:
            return [self.version]
        return []

    def insert(self, table, data):
        self.inserts.append((table, data))

    def update(self, table, data, where_sql, where_params=None):
        self.updates.append((table, data, where_sql, where_params or []))


def test_factcheck_articles_for_review_gate_writes_fact_check_and_ready_status():
    fake_db = FakeDB()

    def fake_call_agent(**_kwargs):
        return {
            "ok": True,
            "data": {
                "articleTitle": "亚马逊广告 ACoS 怎么降",
                "overallRisk": "low",
                "claims": [{
                    "claim": "Prime Day 前应复盘搜索词报告",
                    "category": "operational_advice",
                    "risk": "low",
                    "sourceNeeded": False,
                    "recommendedSourceGroup": "official_amazon",
                    "action": "keep",
                    "reason": "操作建议",
                    "suggestedRewrite": "",
                }],
                "mustFixBeforePublish": [],
                "niceToHaveBeforePublish": [],
                "publishReadiness": "ready_after_minor_edits",
            },
        }

    result = factcheck_articles_for_review_gate(limit=1, engine_run_id="engine_test", database=fake_db, call_agent=fake_call_agent)

    assert result["ok"] is True
    assert result["succeeded"] == 1
    assert any(table == "fact_checks" for table, _ in fake_db.inserts)
    assert any(table == "articles" and data["status"] == "ready_for_review" for table, data, *_ in fake_db.updates)
