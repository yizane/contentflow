from __future__ import annotations

from contentflow.domains.production.article_generation import generate_articles_from_writing_tasks


class FakeDB:
    def __init__(self):
        self.inserts = []
        self.updates = []
        self.writing_task = {
            "id": "job_1",
            "engine_run_id": "engine_test",
            "topic_candidate_id": "tc_1",
            "topic": "亚马逊广告 ACoS 怎么降",
            "primary_keyword": "亚马逊广告",
            "secondary_keywords_json": ["ACoS"],
            "category": "ppc-acos",
            "content_angle": "预算重构",
            "business_angle": "降本",
            "source_urls_json": ["https://advertising.amazon.com/blog/post"],
            "strategy": "balanced",
            "content_type": "operation_guide",
            "business_category": "ppc_acos",
            "topic_cluster": "ppc_intent_keywords",
            "status": "pending",
        }

    def query(self, sql, params=None):
        if "FROM article_writing_tasks" in sql:
            return [self.writing_task]
        if "FROM articles WHERE slug" in sql:
            return []
        return []

    def insert(self, table, data):
        self.inserts.append((table, data))

    def update(self, table, data, where_sql, where_params=None):
        self.updates.append((table, data, where_sql, where_params or []))


def valid_article_payload():
    markdown = "# 亚马逊广告 ACoS 怎么降\n\n" + ("这是一段面向亚马逊卖家的广告预算重构说明，包含步骤、日期、来源和操作建议。\n" * 45)
    visual = {
        "id": "visual_1",
        "placement": "after_section_2",
        "visualType": "process_flow",
        "title": "预算重构流程",
        "purpose": "帮助理解操作路径",
        "description": "展示从搜索词清理到预算重分配的流程",
        "caption": "广告预算重构流程",
        "altText": "亚马逊广告预算重构流程图",
        "imagePrompt": "A clean process flow for Amazon PPC budget restructuring",
        "required": True,
    }
    return {
        "article": {
            "articleTitle": "亚马逊广告 ACoS 怎么降：Prime Day 前的预算重构 SOP",
            "slug": "amazon-ads-acos-budget-sop",
            "metaTitle": "亚马逊广告 ACoS 怎么降",
            "metaDescription": "这是一份面向亚马逊卖家的广告预算重构 SOP，帮助在 Prime Day 前识别烧钱词、重分配预算并控制 ACoS。",
            "category": "ppc-acos",
            "tags": ["亚马逊广告", "ACoS"],
            "primaryKeyword": "亚马逊广告",
            "secondaryKeywords": ["ACoS"],
            "articleMarkdown": markdown,
            "faqJson": [
                {"question": "ACoS 太高先看什么？", "answer": "先看搜索词报告和预算消耗分布。"},
                {"question": "Prime Day 前要加预算吗？", "answer": "只给转化词加预算，不给泛词盲目加。"},
                {"question": "CPC 上涨怎么办？", "answer": "拆分意图词并降低低转化词出价。"},
                {"question": "多久复盘一次？", "answer": "旺季前建议每两到三天复盘一次。"},
            ],
            "schemaJsonLd": {"@type": "Article"},
            "sources": [{
                "title": "Amazon Ads update",
                "sourceName": "Amazon Ads Blog",
                "sourceUrl": "https://advertising.amazon.com/blog/post",
                "retrievedAt": "2026-06-01T00:00:00Z",
                "asOf": "2026-06-01",
                "sourceType": "official",
                "sourceTrust": "primary_fact",
            }],
            "internalLinks": [{"anchorText": "广告结构", "targetSlug": "amazon-ads-structure", "reason": "同属广告优化主题"}],
            "flyfusCta": "如果你需要把广告词和 Listing 语义一起重构，Flyfus 可以辅助梳理。",
            "visualPlan": [visual, {**visual, "id": "visual_2", "visualType": "checklist_card", "title": "复盘清单"}],
        },
        "quality": {
            "score": 86,
            "publishRecommendation": "publish",
            "breakdown": {"searchIntent": 18, "informationGain": 17, "actionability": 14, "seo": 13, "geo": 13, "facts": 8, "brandFit": 3},
            "issues": [],
            "requiredFixes": [],
        },
    }


def test_generate_articles_from_writing_tasks_generates_article_version_and_quality_report():
    fake_db = FakeDB()

    def fake_call_agent(**_kwargs):
        return {"ok": True, "data": valid_article_payload(), "modelRunId": "mrun_generation"}

    result = generate_articles_from_writing_tasks(limit=1, engine_run_id="engine_test", database=fake_db, call_agent=fake_call_agent)

    assert result["ok"] is True
    assert result["succeeded"] == 1
    assert {table for table, _ in fake_db.inserts} >= {"articles", "article_versions", "quality_reports", "content_classifications"}
    assert any(table == "article_writing_tasks" and data["status"] == "generated" for table, data, *_ in fake_db.updates)
    assert any(table == "topic_candidates" and data["status"] == "generated" for table, data, *_ in fake_db.updates)
    model_run_updates = [item for item in fake_db.updates if item[0] == "model_runs"]
    assert model_run_updates
    _, data, where_sql, where_params = model_run_updates[0]
    assert where_sql == "id = %s"
    assert where_params == ["mrun_generation"]
    assert data["article_id"] == result["results"][0]["articleId"]
    assert data["article_version_id"] == result["results"][0]["versionId"]
