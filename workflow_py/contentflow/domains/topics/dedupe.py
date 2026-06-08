from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from contentflow.domains.sources.identity import jaccard, normalized_topic

DEFAULT_TOPIC_DEDUPE = {
    "shadow_similarity_threshold": 0.75,
    "defer_similarity_threshold": 0.55,
    "penalty_similarity_threshold": 0.35,
    "duplicate_defer_days": 14,
}


def topic_dedupe_policy(policy: dict[str, Any] | None = None) -> dict[str, Any]:
    policy = policy or {}
    return {**DEFAULT_TOPIC_DEDUPE, **(policy.get("topic_dedupe") or policy)}


def duplicate_defer_until(now: datetime | str | None = None, days: int = DEFAULT_TOPIC_DEDUPE["duplicate_defer_days"]) -> str:
    if isinstance(now, datetime):
        base = now
    elif isinstance(now, str) and now:
        raw = now.replace(" ", "T")
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        base = datetime.fromisoformat(raw)
    else:
        base = datetime.now(timezone.utc)
    if base.tzinfo is None:
        base = base.replace(tzinfo=timezone.utc)
    return (base.astimezone(timezone.utc) + timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]


def topic_text(row: dict[str, Any]) -> str:
    return row.get("topic") or row.get("title") or row.get("t") or row.get("normalized") or ""


def find_most_similar(candidate: dict[str, Any], recent_topics: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    candidate_topic = candidate.get("topic") or candidate.get("title") or ""
    candidate_norm = normalized_topic(candidate_topic)
    best = {"similarity": 0.0, "duplicateOfTopicCandidateId": None, "duplicateOfTopic": None, "exact": False}
    for row in recent_topics or []:
        text = topic_text(row)
        if not text:
            continue
        row_norm = row.get("normalized_topic") or row.get("normalized") or normalized_topic(text)
        exact = bool(candidate_norm and row_norm and candidate_norm == row_norm)
        similarity = 1.0 if exact else max(jaccard(candidate_topic, text), jaccard(candidate_norm, row_norm))
        if similarity > best["similarity"]:
            best = {
                "similarity": similarity,
                "duplicateOfTopicCandidateId": row.get("id") or row.get("topic_candidate_id"),
                "duplicateOfTopic": text,
                "exact": exact,
            }
    return best


def decide_topic_dedupe(candidate: dict[str, Any], recent_topics: list[dict[str, Any]] | None = None, policy: dict[str, Any] | None = None, options: dict[str, Any] | None = None) -> dict[str, Any]:
    options = options or {}
    policy = policy or {}
    p = topic_dedupe_policy(policy)
    best = find_most_similar(candidate, recent_topics)
    primary_keyword = candidate.get("primaryKeyword") or candidate.get("primary_keyword")

    if best["exact"]:
        return {
            "decision": "shadow_duplicate",
            "duplicateOfTopicCandidateId": best["duplicateOfTopicCandidateId"],
            "similarity": 1,
            "reason": f"normalized topic exact duplicate: {str(best['duplicateOfTopic'] or '')[:80]}",
            "maxSimilarity": best["similarity"],
        }
    if best["similarity"] >= p["shadow_similarity_threshold"]:
        return {
            "decision": "shadow_duplicate",
            "duplicateOfTopicCandidateId": best["duplicateOfTopicCandidateId"],
            "similarity": best["similarity"],
            "reason": f"topic similarity {best['similarity']:.2f} >= {p['shadow_similarity_threshold']}",
            "maxSimilarity": best["similarity"],
        }
    if best["similarity"] >= p["defer_similarity_threshold"]:
        return {
            "decision": "deferred_duplicate",
            "duplicateOfTopicCandidateId": best["duplicateOfTopicCandidateId"],
            "similarity": best["similarity"],
            "reason": f"topic similarity {best['similarity']:.2f} >= {p['defer_similarity_threshold']}",
            "maxSimilarity": best["similarity"],
        }

    keyword_article_count = options.get("keywordArticleCount", candidate.get("keywordArticleCount"))
    keyword_limit = options.get("keywordLimit", (policy.get("dedupe") or {}).get("max_articles_per_primary_keyword_in_window", 2))
    if not options.get("ignoreKeywordThrottle") and primary_keyword and keyword_article_count is not None and keyword_article_count >= keyword_limit:
        return {
            "decision": "deferred_keyword",
            "duplicateOfTopicCandidateId": None,
            "similarity": best["similarity"],
            "reason": f'primary_keyword "{primary_keyword}" recent article count {keyword_article_count} >= {keyword_limit}',
            "maxSimilarity": best["similarity"],
        }

    return {
        "decision": "unique",
        "duplicateOfTopicCandidateId": None,
        "similarity": best["similarity"],
        "reason": None,
        "maxSimilarity": best["similarity"],
    }
