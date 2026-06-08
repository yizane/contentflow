from __future__ import annotations

from contentflow.llm.validators import validate_topic_candidates_data


def valid_candidate(topic="亚马逊广告 ACoS 怎么降"):
    return {
        "topic": topic,
        "primaryKeyword": "亚马逊广告",
        "secondaryKeywords": ["ACoS"],
        "category": "ppc-acos",
        "contentType": "operation_guide",
        "businessCategory": "ppc_acos",
        "topicCluster": "ppc_intent_keywords",
        "contentAngle": "Prime Day 前广告预算重构",
        "businessAngle": "降低旺季烧钱风险",
        "sourceUrls": ["https://advertising.amazon.com/blog/post"],
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


def test_validate_topic_candidates_accepts_schema_valid_payload():
    payload = {"generatedAt": "2026-06-01", "candidates": [valid_candidate(f"亚马逊广告 ACoS 怎么降 {i}") for i in range(5)]}
    result = validate_topic_candidates_data(payload, {"亚马逊广告"})

    assert result.ok is True
    assert result.issues == []


def test_validate_topic_candidates_reports_schema_and_business_issues():
    payload = {"generatedAt": "2026-06-01", "candidates": [valid_candidate("Rufus 时代 亚马逊广告"), valid_candidate("Rufus 时代 亚马逊广告")]}
    result = validate_topic_candidates_data(payload, {"其他关键词"})

    assert result.ok is False
    assert any("too short" in issue or "is too short" in issue or "candidates" in issue for issue in result.issues)
    assert any("过期口径" in issue for issue in result.issues)
    assert any("重复" in issue for issue in result.issues)
    assert any("不在关键词库" in warning for warning in result.warnings)
