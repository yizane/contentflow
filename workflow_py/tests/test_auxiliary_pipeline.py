from __future__ import annotations

from contentflow.domains.production import article_quality, packages, review, source_resolution
from contentflow.domains.taxonomy import classification
from contentflow.domains.topics import audition


class MemoryDB:
    def __init__(self):
        self.inserts = []
        self.updates = []
        self.queries = []
        self.article = {
            "id": "article_1",
            "title": "亚马逊广告 ACoS 怎么降",
            "slug": "amazon-acos-guide",
            "status": "needs_fact_sources",
            "primary_keyword": "亚马逊广告",
            "quality_score": 82,
            "publish_recommendation": "revise",
            "article_quality_score": 86,
            "content_type": "operation_guide",
            "business_category": "ppc_acos",
            "topic_cluster": "ppc_intent_keywords",
        }
        self.article_json = revised_article_payload()
        self.fact_check = {
            "claims": [{"claim": "Prime Day 前 CPC 会上涨", "risk": "medium", "action": "cite_required", "sourceNeeded": True}],
            "mustFixBeforePublish": ["补充 CPC 上涨来源"],
        }
        self.version = {
            "id": "ver_1",
            "article_id": "article_1",
            "article_markdown": self.article_json["articleMarkdown"],
            "article_json": self.article_json,
            "fact_check_json": self.fact_check,
            "quality_json": {"score": 82, "publishRecommendation": "revise"},
            "article_quality_score": None,
            "visual_plan_json": self.article_json["visualPlan"],
            "source_resolution_json": None,
            "quality_score": 82,
            "publish_recommendation": "revise",
            "strategy": "balanced",
        }

    def query(self, sql, params=None):
        self.queries.append((sql, params or []))
        if "FROM article_versions" in sql and "COUNT" not in sql:
            return [self.version]
        if "COUNT(*) c FROM article_versions" in sql:
            return [{"c": 1}]
        if "FROM articles WHERE id" in sql:
            return [self.article]
        if "FROM articles WHERE status" in sql:
            return [self.article]
        if "SELECT title FROM articles" in sql:
            return []
        if "FROM fact_checks" in sql:
            return [{"id": "fact_1", "must_fix_json": self.fact_check["mustFixBeforePublish"]}]
        if "FROM source_resolutions" in sql and "GROUP BY" in sql:
            return [{"resolved_status": "resolved", "c": 1}]
        if "FROM seo_geo_scores" in sql:
            return [{"seo_score": 80, "geo_score": 82, "overall_score": 81, "strategy": "balanced"}]
        if "FROM channel_outputs" in sql:
            return []
        if "FROM topic_candidates" in sql:
            return [
                {"id": "tc_1", "topic": "亚马逊广告 ACoS 怎么降", "score": 92, "content_value_score": 88, "selection_score": None, "business_category": "ppc_acos", "content_type": "operation_guide", "topic_cluster": "ppc_intent_keywords", "primary_keyword": "亚马逊广告"},
                {"id": "tc_2", "topic": "亚马逊评论差评怎么处理", "score": 91, "content_value_score": 86, "selection_score": None, "business_category": "review_qa", "content_type": "operation_guide", "topic_cluster": None, "primary_keyword": "亚马逊差评"},
            ]
        return []

    def insert(self, table, data):
        self.inserts.append((table, data))
        if table == "article_versions":
            self.version = {**self.version, **data}

    def update(self, table, data, where_sql, where_params=None):
        self.updates.append((table, data, where_sql, where_params or []))
        if table == "article_versions":
            self.version.update(data)
        if table == "articles":
            self.article.update(data)


def visual_plan():
    return [
        {"id": "visual_1", "placement": "after_section_1", "visualType": "process_flow", "title": "广告排查流程", "purpose": "帮助理解步骤", "description": "展示从搜索词到预算调整的流程", "caption": "广告排查流程", "altText": "亚马逊广告排查流程图", "imagePrompt": "A clean process flow for Amazon PPC optimization", "required": True},
        {"id": "visual_2", "placement": "after_section_2", "visualType": "checklist_card", "title": "预算检查清单", "purpose": "辅助执行", "description": "列出 Prime Day 前预算检查项", "caption": "预算检查清单", "altText": "亚马逊广告预算检查清单", "imagePrompt": "A checklist card for Amazon sellers advertising budget", "required": False},
    ]


def revised_article_payload():
    markdown = "# 亚马逊广告 ACoS 怎么降\n\n" + ("这是面向亚马逊卖家的广告优化正文，包含搜索词、预算、出价和否词执行建议。\n" * 80)
    return {
        "articleTitle": "亚马逊广告 ACoS 怎么降",
        "slug": "amazon-acos-guide",
        "metaTitle": "亚马逊广告 ACoS 怎么降",
        "metaDescription": "这篇文章说明亚马逊广告 ACoS 偏高时，卖家如何从搜索词、预算和出价结构入手降低浪费。",
        "category": "ppc-acos",
        "tags": ["亚马逊广告", "ACoS"],
        "primaryKeyword": "亚马逊广告",
        "secondaryKeywords": ["ACoS"],
        "articleMarkdown": markdown,
        "faqJson": [
            {"question": "ACoS 偏高先看什么？", "answer": "先看搜索词和转化成本。"},
            {"question": "什么时候否词？", "answer": "连续消耗但无转化时处理。"},
            {"question": "预算怎么调？", "answer": "优先保留高转化广告组预算。"},
            {"question": "Prime Day 前要做什么？", "answer": "提前检查出价、预算和库存。"},
        ],
        "schemaJsonLd": {"@type": "Article"},
        "sources": [{"title": "Amazon Ads guide", "sourceName": "Amazon Ads", "sourceUrl": "https://advertising.amazon.com/library/guides", "retrievedAt": "2026-06-07T00:00:00Z", "asOf": "2026-06-07", "sourceType": "official", "sourceTrust": "primary_fact"}],
        "internalLinks": [{"anchorText": "亚马逊广告", "targetSlug": "amazon-ads", "reason": "主题相关"}],
        "flyfusCta": "需要系统化优化广告结构，可以用 Flyfus 做持续追踪。",
        "visualPlan": visual_plan(),
    }


def quality_payload():
    return {
        "articleQualityScore": 86,
        "breakdown": {"sellerPainFit": 18, "actionability": 18, "informationGain": 17, "originality": 8, "clarity": 9, "evidenceUse": 8, "businessUsefulness": 8},
        "strengths": ["执行性强"],
        "issues": [],
        "mustFix": [],
        "niceToHave": [],
        "qualityRecommendation": "good",
    }


def resolution_payload():
    return {
        "articleId": "article_1",
        "overallResolutionStatus": "resolved",
        "items": [{
            "claim": "Prime Day 前 CPC 会上涨",
            "claimCategory": "ads",
            "risk": "medium",
            "action": "cite_required",
            "recommendedSourceGroup": "official_amazon",
            "resolvedStatus": "resolved",
            "source": {"title": "Amazon Ads guide", "url": "https://advertising.amazon.com/library/guides", "sourceName": "Amazon Ads", "sourceType": "official", "sourceTrust": "primary_fact"},
            "evidenceSummary": "官方广告指南可支撑广告优化建议",
            "suggestedRewrite": "改为更保守表述并引用来源",
            "notes": "",
        }],
        "mustFixRemaining": [],
        "readyForRevision": True,
    }


def test_article_quality_scores_and_updates_version():
    fake = MemoryDB()

    def fake_call_agent(**_kwargs):
        return {"ok": True, "data": quality_payload()}

    result = article_quality.score_article_quality(fake.article, engine_run_id="engine_test", force=True, database=fake, call_agent=fake_call_agent)

    assert result["ok"] is True
    assert result["articleQualityScore"] == 86
    assert any(table == "article_quality_scores" for table, _ in fake.inserts)
    assert any(table == "articles" and data["article_quality_score"] == 86 for table, data, *_ in fake.updates)


def test_source_resolution_writes_rows_and_revision_creates_new_version():
    fake = MemoryDB()

    def fake_resolve(**_kwargs):
        return {"ok": True, "data": resolution_payload()}

    resolved = source_resolution.resolve_sources_for_article(fake.article, engine_run_id="engine_test", database=fake, call_agent=fake_resolve)
    assert resolved["ok"] is True
    assert any(table == "source_resolutions" for table, _ in fake.inserts)

    fake.version["source_resolution_json"] = resolved["resolution"]

    def fake_revision(**_kwargs):
        return {"ok": True, "data": revised_article_payload()}

    revised = source_resolution.revise_article_with_resolution(fake.article, resolved["resolution"], engine_run_id="engine_test", database=fake, call_agent=fake_revision)
    assert revised["ok"] is True
    assert any(table == "article_versions" and data["generation_mode"] == "fact_checked_revision" for table, data in fake.inserts)
    assert any(table == "articles" and "current_version_id" in data for table, data, *_ in fake.updates)


def test_find_articles_filters_batch_source_fix_by_engine_run_id():
    fake = MemoryDB()

    source_resolution._find_articles(article_id=None, status="needs_fact_sources", limit=5, database=fake, engine_run_id="engine_test")

    sql, params = fake.queries[-1]
    assert "engine_run_id = %s" in sql
    assert params == ["needs_fact_sources", "engine_test"]


def test_review_mark_blocks_low_quality_and_writes_audit_for_valid_transition():
    fake = MemoryDB()
    fake.article["status"] = "ready_for_review"
    fake.article["article_quality_score"] = 76
    blocked = review.mark_review(article_id="article_1", status="reviewed", database=fake)
    assert blocked["ok"] is False
    assert "质量主评分" in blocked["error"]

    fake.article["article_quality_score"] = 86
    marked = review.mark_review(article_id="article_1", status="reviewed", database=fake)
    assert marked["ok"] is True
    assert any(table == "review_actions" for table, _ in fake.inserts)
    assert any(table == "status_transitions" for table, _ in fake.inserts)


def test_package_export_writes_publish_package():
    fake = MemoryDB()
    fake.article["status"] = "ready_for_review"
    result = packages.export_article(fake.article, database=fake)

    assert result["ok"] is True
    assert any(table == "publish_packages" for table, _ in fake.inserts)


def test_rule_classification_and_audition_write_audit_rows():
    fake = MemoryDB()
    rows = [{"id": "source_1", "title": "亚马逊广告 ACoS 降本指南", "summary": "", "source_group": "news", "source_name": "AMZ123 快讯"}]
    stats = classification.classify_rows(entity="source_items", rows=rows, no_ai=True, database=fake)

    assert stats["classified"] == 1
    assert any(table == "content_classifications" for table, _ in fake.inserts)

    result = audition.run_topic_audition(rounds=2, limit=1, database=fake)
    assert result["ok"] is True
    assert any(table == "topic_audition_runs" for table, _ in fake.inserts)
    assert any(table == "topic_audition_items" for table, _ in fake.inserts)
