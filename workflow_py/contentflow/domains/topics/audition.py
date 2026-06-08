from __future__ import annotations

from collections import Counter
from typing import Any

from contentflow.core import db
from contentflow.domains.topics.selection import calculate_portfolio_stats, calculate_selection_score, portfolio_policy
from contentflow.domains.sources.identity import jaccard


def _summary_pick(candidate: dict[str, Any], selection_score: int) -> dict[str, Any]:
    return {
        "topic": candidate.get("topic"),
        "contentType": candidate.get("content_type"),
        "businessCategory": candidate.get("business_category"),
        "topicCluster": candidate.get("topic_cluster"),
        "primaryKeyword": candidate.get("primary_keyword"),
        "rawScore": candidate.get("score"),
        "contentValueScore": candidate.get("content_value_score"),
        "selectionScore": selection_score,
    }


def _sim_stats(base: dict[str, Any], selections: list[dict[str, Any]]) -> dict[str, Any]:
    stats = {
        "now": base["now"],
        "categoryCounts": {key: dict(value) for key, value in base["categoryCounts"].items()},
        "clusterCounts": {key: dict(value) for key, value in base["clusterCounts"].items()},
        "keywordCounts14d": dict(base["keywordCounts14d"]),
        "recentTitles": list(base["recentTitles"]),
        "recentTopics": list(base["recentTopics"]),
        "totalArticles14d": int(base.get("totalArticles14d") or 0),
    }
    for item in selections:
        cat = item.get("business_category")
        cluster = item.get("topic_cluster")
        keyword = item.get("primary_keyword")
        if cat:
            for window in ["d7", "d14", "d30"]:
                stats["categoryCounts"][window][cat] = stats["categoryCounts"][window].get(cat, 0) + 1
            stats["totalArticles14d"] += 1
        if cluster:
            for window in ["d14", "d30", "all"]:
                stats["clusterCounts"][window][cluster] = stats["clusterCounts"][window].get(cluster, 0) + 1
        if keyword:
            stats["keywordCounts14d"][keyword] = stats["keywordCounts14d"].get(keyword, 0) + 1
        if item.get("topic"):
            stats["recentTitles"].append(item["topic"])
            stats["recentTopics"].append({"topic": item["topic"], "normalized": item.get("normalized_topic")})
    return stats


def run_topic_audition(*, rounds: int = 10, limit: int = 1, min_score: int = 80, engine_run_id: str | None = None, refresh_candidates: bool = False, database: Any | None = None) -> dict[str, Any]:
    database = database or db.Database()
    if refresh_candidates:
        from contentflow.domains.topics.generation import generate_topics

        refresh_info = generate_topics(engine_run_id=engine_run_id, database=database)
    else:
        refresh_info = None
    pool = database.query(
        f"""
        SELECT * FROM topic_candidates
        WHERE status IN ('candidate','selected','deferred')
          AND score >= %s
        ORDER BY COALESCE(selection_score, content_value_score, score) DESC, score DESC, created_at DESC
        LIMIT 200
        """,
        [min_score],
    )
    picked_ids: set[str] = set()
    rounds_out: list[dict[str, Any]] = []
    item_rows: list[dict[str, Any]] = []
    audition_id = db.make_id("audition")
    base_stats = calculate_portfolio_stats(database=database)
    policy = portfolio_policy()
    sim_selections: list[dict[str, Any]] = []
    for round_no in range(1, max(1, min(60, rounds)) + 1):
        selected = []
        used_clusters: set[str] = set()
        eligible = [candidate for candidate in pool if candidate["id"] not in picked_ids]
        stats = _sim_stats(base_stats, sim_selections)
        decisions = [{"candidate": candidate, "decision": calculate_selection_score(candidate, stats, policy)} for candidate in eligible]
        for item in sorted(decisions, key=lambda row: (row["decision"]["selectionScore"], row["decision"]["rawScore"]), reverse=True):
            candidate = item["candidate"]
            decision = item["decision"]
            if not decision["eligible"]:
                item_rows.append({"round": round_no, "candidate": candidate, "decision": decision["selectionStatus"], "reason": decision.get("skipReason"), "selectionScore": decision["selectionScore"], "debug": decision})
                continue
            if len(selected) >= max(1, min(5, limit)):
                break
            cluster = candidate.get("topic_cluster")
            if cluster and cluster in used_clusters:
                item_rows.append({"round": round_no, "candidate": candidate, "decision": "batch_skipped", "reason": f"批内已选同主题簇 {cluster}", "selectionScore": decision["selectionScore"], "debug": decision})
                continue
            selected.append(candidate)
            picked_ids.add(candidate["id"])
            sim_selections.append(candidate)
            if cluster:
                used_clusters.add(cluster)
            item_rows.append({"round": round_no, "candidate": candidate, "decision": "selected", "reason": "组合选中", "selectionScore": decision["selectionScore"], "debug": decision})
        rounds_out.append({"round": round_no, "picks": [_summary_pick(item["candidate"], item["debug"]["selectionScore"]) for item in item_rows if item["round"] == round_no and item["decision"] == "selected"], "poolLeft": len(eligible) - len(selected)})
    all_picks = [pick for round_item in rounds_out for pick in round_item["picks"]]
    category_counter = Counter(pick.get("businessCategory") or "null" for pick in all_picks)
    cluster_counter = Counter(pick.get("topicCluster") or "null" for pick in all_picks)
    type_counter = Counter(pick.get("contentType") or "null" for pick in all_picks)
    similar_pairs: list[dict[str, Any]] = []
    max_similarity = 0.0
    for i, left in enumerate(all_picks):
        for right in all_picks[i + 1:]:
            similarity = jaccard(left.get("topic") or "", right.get("topic") or "")
            max_similarity = max(max_similarity, similarity)
            if similarity >= 0.35:
                similar_pairs.append({"a": (left.get("topic") or "")[:60], "b": (right.get("topic") or "")[:60], "sim": round(similarity, 2)})
    repetition_risk = "high" if max_similarity >= 0.45 else "medium" if max_similarity >= 0.3 else "low"
    summary = {
        "rounds": rounds,
        "limitPerRound": limit,
        "totalSelected": len(all_picks),
        "refreshInfo": refresh_info,
        "businessCategoryDistribution": dict(category_counter.most_common()),
        "topicClusterDistribution": dict(cluster_counter.most_common()),
        "contentTypeDistribution": dict(type_counter.most_common()),
        "categoriesCovered": len([key for key in category_counter if key != "null"]),
        "avgContentValueScore": round(sum((pick.get("contentValueScore") or 0) for pick in all_picks) / len(all_picks), 1) if all_picks else None,
        "repetitionRisk": repetition_risk,
        "similarTopics": similar_pairs[:8],
        "readyVerdict": "可以开始真实生成文章" if all_picks and repetition_risk == "low" else "建议先检查候选池或重复风险",
    }
    now = db.now()
    database.insert("topic_audition_runs", {
        "id": audition_id,
        "engine_run_id": engine_run_id,
        "rounds": rounds,
        "limit_per_round": limit,
        "policy_json": {"min_score": min_score, "mode": "portfolio_balanced_python", "selection_policy": policy.get("selection_policy"), "defer_policy": policy.get("defer_policy")},
        "summary_json": {**summary, "days": rounds_out},
        "status": "completed",
        "created_at": now,
    })
    for item in item_rows:
        candidate = item["candidate"]
        database.insert("topic_audition_items", {
            "id": db.make_id("audit"),
            "audition_run_id": audition_id,
            "round_no": item["round"],
            "topic_candidate_id": candidate.get("id"),
            "topic": str(candidate.get("topic") or "")[:510],
            "content_type": candidate.get("content_type"),
            "business_category": candidate.get("business_category"),
            "topic_cluster": candidate.get("topic_cluster"),
            "primary_keyword": candidate.get("primary_keyword"),
            "raw_score": candidate.get("score"),
            "content_value_score": candidate.get("content_value_score"),
            "selection_score": item["selectionScore"],
            "decision": item["decision"],
            "decision_reason": item["reason"],
            "portfolio_debug_json": {"mode": "portfolio_balanced_python", "penalties": item.get("debug", {}).get("penalties"), "bonuses": item.get("debug", {}).get("bonuses"), "similarity": item.get("debug", {}).get("similarity")},
            "created_at": now,
        })
    return {"ok": True, "auditionId": audition_id, "summary": summary, "days": rounds_out}
