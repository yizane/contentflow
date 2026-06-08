from __future__ import annotations

from contentflow.domains.production.scoring import run_scores


class FakeDB:
    def __init__(self):
        self.inserts = []
        self.updates = []
        self.article = {"id": "article_1", "engine_run_id": "engine_test", "status": "ready_for_review"}
        self.version = {"id": "ver_1", "article_id": "article_1", "article_markdown": "# Title\n\nBody", "article_json": {}}

    def query(self, sql, params=None):
        if "FROM articles WHERE status" in sql:
            return [self.article]
        if "FROM article_versions" in sql:
            return [self.version]
        if "FROM seo_geo_scores" in sql:
            return []
        return []

    def insert(self, table, data):
        self.inserts.append((table, data))

    def update(self, table, data, where_sql, where_params=None):
        self.updates.append((table, data, where_sql, where_params or []))


def score_payload():
    seo = {
        "seoScore": 86,
        "breakdown": {"searchIntentMatch": 14, "keywordTargeting": 14, "serpDifferentiation": 13, "titleMetaOptimization": 9, "headingStructure": 9, "internalLinkOpportunity": 8, "schemaReadiness": 8, "freshnessAndSource": 8, "readability": 3},
        "strengths": [],
        "issues": [],
        "recommendedFixes": [],
        "seoRecommendation": "good",
    }
    geo = {
        "geoScore": 88,
        "breakdown": {"answerFirst": 14, "extractableStructure": 14, "entityClarity": 14, "citationReadiness": 13, "questionCoverage": 9, "comparisonAndCriteria": 9, "factualCaution": 8, "chunkability": 7},
        "strengths": [],
        "issues": [],
        "recommendedFixes": [],
        "geoRecommendation": "good",
    }
    dual = {
        "overallScore": 87,
        "seoScore": 86,
        "geoScore": 88,
        "factScore": 85,
        "businessFitScore": 88,
        "readabilityScore": 84,
        "strategy": "balanced",
        "recommendation": "ready_for_review",
        "seo": seo,
        "geo": geo,
        "summary": "整体质量较好，可以进入终审处理",
        "mustFix": [],
        "niceToHave": [],
    }
    return {"seo": seo, "geo": geo, "dual": dual}


def test_run_scores_writes_seo_geo_score_and_updates_article():
    fake_db = FakeDB()

    def fake_call_agent(**_kwargs):
        return {"ok": True, "data": score_payload()}

    result = run_scores(status="ready_for_review", strategy="balanced", engine_run_id="engine_test", database=fake_db, call_agent=fake_call_agent)

    assert result["ok"] is True
    assert result["scored"] == 1
    assert any(table == "seo_geo_scores" for table, _ in fake_db.inserts)
    assert any(table == "articles" and data["seo_score"] == 86 and data["geo_score"] == 88 for table, data, *_ in fake_db.updates)
