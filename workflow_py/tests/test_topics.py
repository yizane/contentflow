from __future__ import annotations

from contentflow.domains.topics.dedupe import decide_topic_dedupe, duplicate_defer_until
from contentflow.domains.topics.source_relevance import (
    apply_candidate_source_score_guard,
    assess_candidate_source_relevance,
    build_source_url_map,
    source_ids_for_candidate,
)


def test_topic_dedupe_shadows_exact_normalized_topic():
    decision = decide_topic_dedupe(
        {"topic": "亚马逊关闭差评买家主动联系入口后，卖家如何重建差评处理 SOP"},
        [{"id": "tc_1", "topic": "亚马逊关闭差评买家主动联系入口后卖家如何重建差评处理SOP"}],
    )

    assert decision["decision"] == "shadow_duplicate"
    assert decision["duplicateOfTopicCandidateId"] == "tc_1"
    assert decision["similarity"] == 1


def test_topic_dedupe_defers_keyword_when_recent_articles_hit_limit():
    decision = decide_topic_dedupe(
        {"topic": "Prime Day 前广告预算怎么调", "primaryKeyword": "Prime Day 广告", "keywordArticleCount": 2},
        [],
        {"dedupe": {"max_articles_per_primary_keyword_in_window": 2}},
    )

    assert decision["decision"] == "deferred_keyword"
    assert "Prime Day 广告" in decision["reason"]
    assert duplicate_defer_until("2026-06-01T00:00:00.000Z", 14).startswith("2026-06-15")


def test_source_relevance_allows_only_amazon_ecommerce_sources():
    source_by_url = build_source_url_map([
        {
            "id": "source_1",
            "source_group": "official_amazon",
            "source_name": "Amazon Ads Blog",
            "source_url": "https://advertising.amazon.com/blog/post",
            "title": "Sponsored Products update",
        }
    ])
    relevance = assess_candidate_source_relevance({"sourceUrls": ["https://advertising.amazon.com/blog/post"]}, source_by_url)

    assert relevance["hasOnlyAmazonEcommerceSources"] is True
    guarded = apply_candidate_source_score_guard({"score": 90, "contentValueScore": 92}, relevance)
    assert guarded["score"] == 90
    assert guarded["rejected"] is False
    assert source_ids_for_candidate({"sourceUrls": ["https://advertising.amazon.com/blog/post"]}, source_by_url) == ["source_1"]


def test_source_relevance_caps_non_amazon_ecommerce_sources():
    source_by_url = build_source_url_map([
        {
            "id": "source_2",
            "source_group": "market_news",
            "source_name": "Marketplace Pulse",
            "source_url": "https://example.com/ru",
            "title": "Russian e-commerce marketplace Wildberries update",
            "summary": "Ozon and Yandex Market competition",
        }
    ])
    relevance = assess_candidate_source_relevance({"sourceUrls": ["https://example.com/ru"]}, source_by_url)
    guarded = apply_candidate_source_score_guard({"score": 92, "contentValueScore": 90}, relevance)

    assert relevance["hasOnlyAmazonEcommerceSources"] is False
    assert relevance["hasNonAmazonEcommerceSource"] is True
    assert guarded["score"] == 59
    assert guarded["contentValueScore"] == 59
    assert guarded["priority"] == "P2"
    assert guarded["rejected"] is True
