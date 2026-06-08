from __future__ import annotations

import os
from datetime import timedelta
from typing import Any

from contentflow.core import config, db
from contentflow.flow import runtime
from contentflow.domains.topics.dedupe import decide_topic_dedupe

STRATEGIES = {"balanced", "seo_first", "geo_first"}


def _json_array(value: Any) -> list[Any]:
    parsed = db.as_json(value)
    return parsed if isinstance(parsed, list) else []


def _count_map(rows: list[dict[str, Any]]) -> dict[str, int]:
    return {row["k"]: int(row["c"] or 0) for row in rows if row.get("k")}


def portfolio_policy() -> dict[str, Any]:
    return config.read_yaml("content_portfolio")


def _days_ago(days: int) -> str:
    now = runtime.engine_now_date(os.environ.get("ENGINE_NOW"))
    return runtime.mysql_datetime_from_date(now - timedelta(days=days))


def calculate_portfolio_stats(*, database: Any | None = None) -> dict[str, Any]:
    database = database or db.Database()
    not_archived = "status != 'archived'"
    cat7 = database.query(f"SELECT business_category k, COUNT(*) c FROM articles WHERE {not_archived} AND created_at >= %s GROUP BY business_category", [_days_ago(7)])
    cat14 = database.query(f"SELECT business_category k, COUNT(*) c FROM articles WHERE {not_archived} AND created_at >= %s GROUP BY business_category", [_days_ago(14)])
    cat30 = database.query(f"SELECT business_category k, COUNT(*) c FROM articles WHERE {not_archived} AND created_at >= %s GROUP BY business_category", [_days_ago(30)])
    cluster14 = database.query(f"SELECT topic_cluster k, COUNT(*) c FROM articles WHERE {not_archived} AND created_at >= %s GROUP BY topic_cluster", [_days_ago(14)])
    cluster30 = database.query(f"SELECT topic_cluster k, COUNT(*) c FROM articles WHERE {not_archived} AND created_at >= %s GROUP BY topic_cluster", [_days_ago(30)])
    cluster_all = database.query(f"SELECT topic_cluster k, COUNT(*) c FROM articles WHERE {not_archived} GROUP BY topic_cluster")
    kw14 = database.query(f"SELECT primary_keyword k, COUNT(*) c FROM articles WHERE {not_archived} AND created_at >= %s GROUP BY primary_keyword", [_days_ago(14)])
    recent_titles = database.query(f"SELECT title t FROM articles WHERE {not_archived} AND created_at >= %s", [_days_ago(30)])
    recent_topics = database.query("SELECT topic t, normalized_topic n FROM topic_candidates WHERE status IN ('selected','generated') AND created_at >= %s", [_days_ago(30)])
    cat14_map = _count_map(cat14)
    return {
        "now": runtime.engine_now_date(os.environ.get("ENGINE_NOW")),
        "categoryCounts": {"d7": _count_map(cat7), "d14": cat14_map, "d30": _count_map(cat30)},
        "clusterCounts": {"d14": _count_map(cluster14), "d30": _count_map(cluster30), "all": _count_map(cluster_all)},
        "keywordCounts14d": _count_map(kw14),
        "recentTitles": [row.get("t") for row in recent_titles if row.get("t")],
        "recentTopics": [{"topic": row.get("t"), "normalized": row.get("n")} for row in recent_topics if row.get("t")],
        "totalArticles14d": sum(cat14_map.values()),
    }


def _future_mysql_datetime(days: int) -> str:
    return runtime.mysql_datetime_from_date(runtime.engine_now_date(os.environ.get("ENGINE_NOW")) + timedelta(days=days))


def _decision_row(candidate: dict[str, Any], *, selection_score: int, status: str = "eligible", reason: str | None = None, penalties: list[dict[str, Any]] | None = None, bonuses: list[dict[str, Any]] | None = None, deferred_until: str | None = None, similarity: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "candidate": candidate,
        "decision": {
            "rawScore": int(candidate.get("raw_score") or candidate.get("score") or 0),
            "contentValueScore": candidate.get("content_value_score"),
            "selectionScore": selection_score,
            "selectionStatus": status,
            "skipReason": reason,
            "deferredUntil": deferred_until,
            "penalties": penalties or [],
            "bonuses": bonuses or [],
            "similarity": similarity or {},
            "eligible": status == "eligible",
        },
    }


def heuristic_value_score(candidate: dict[str, Any], stats: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    topic = str(candidate.get("topic") or "")
    source_count = len(_json_array(candidate.get("source_urls_json")))
    pain = 16 if any(token in topic.lower() for token in ["acos", "封号", "申诉", "退货", "差评", "流量下滑", "断货", "亏", "下架", "侵权", "仓储费", "烧钱"]) else 14 if candidate.get("content_type") == "risk_warning" else 10
    action = 16 if candidate.get("content_type") == "operation_guide" else 12 if candidate.get("content_type") == "qa_discussion" else 9
    info_gain = 13 if source_count >= 2 else 9
    business_fit = 12 if candidate.get("priority") == "P0" else 10 if candidate.get("priority") == "P1" else 8
    non_repetition = 12
    # Reuse topic dedupe similarity indirectly; exact title similarity is handled in calculate_selection_score.
    source_support = min(10, source_count * 3 + 2)
    breakdown = {
        "sellerPainValue": pain,
        "actionability": action,
        "informationGain": info_gain,
        "businessFit": business_fit,
        "nonRepetition": non_repetition,
        "sourceSupport": source_support,
        "_estimated": True,
    }
    return sum(int(v) for key, v in breakdown.items() if key != "_estimated" and isinstance(v, int)), breakdown


def ensure_value_scores(*, engine_run_id: str | None = None, limit: int = 60, database: Any | None = None) -> dict[str, int]:
    database = database or db.Database()
    rows = database.query(
        f"SELECT * FROM topic_candidates WHERE content_value_score IS NULL AND status IN ('candidate','selected','deferred') AND score >= 70 ORDER BY score DESC LIMIT {max(1, min(200, limit))}"
    )
    if not rows:
        return {"scored": 0, "byHeuristic": 0}
    stats = calculate_portfolio_stats(database=database)
    now = db.now()
    for row in rows:
        score, breakdown = heuristic_value_score(row, stats)
        database.update("topic_candidates", {"content_value_score": score, "value_breakdown_json": breakdown, "updated_at": now}, "id = %s", [row["id"]])
        row["content_value_score"] = score
        row["value_breakdown_json"] = breakdown
    return {"scored": len(rows), "byHeuristic": len(rows)}


def _similarity_value(decision: dict[str, Any]) -> float:
    try:
        return float(decision.get("similarity") or 0)
    except (TypeError, ValueError):
        return 0.0


def calculate_selection_score(candidate: dict[str, Any], stats: dict[str, Any], policy: dict[str, Any] | None = None) -> dict[str, Any]:
    policy = policy or portfolio_policy()
    penalties_cfg = policy.get("penalties") or {}
    bonuses_cfg = policy.get("bonuses") or {}
    raw_score = int(candidate.get("raw_score") or candidate.get("score") or 0)
    cluster = candidate.get("topic_cluster")
    category = candidate.get("business_category")
    penalties: list[dict[str, Any]] = []
    bonuses: list[dict[str, Any]] = []
    selection_status = "eligible"
    skip_reason = None
    defer_days = int((policy.get("defer_policy") or {}).get("default_defer_days") or 14)
    deferred_until = _future_mysql_datetime(defer_days)

    if cluster:
        limits = ((policy.get("topic_cluster_limits") or {}).get(cluster) or (policy.get("topic_cluster_limits") or {}).get("default") or {"max_articles_14d": 1, "max_articles_30d": 2})
        c14 = stats["clusterCounts"]["d14"].get(cluster, 0)
        c30 = stats["clusterCounts"]["d30"].get(cluster, 0)
        if c14 >= int(limits.get("max_articles_14d", 1)):
            value = -int(penalties_cfg.get("topic_cluster_saturation_14d", 40))
            penalties.append({"type": "topic_cluster_saturation_14d", "value": value, "reason": f"topic_cluster {cluster} 近 14 天已有 {c14} 篇，上限 {limits.get('max_articles_14d')}"})
            selection_status = "skipped_quota"
            skip_reason = f"topic_cluster {cluster} saturated（14d {c14}/{limits.get('max_articles_14d')}）"
        elif c30 >= int(limits.get("max_articles_30d", 2)):
            value = -int(penalties_cfg.get("topic_cluster_saturation_30d", 25))
            penalties.append({"type": "topic_cluster_saturation_30d", "value": value, "reason": f"topic_cluster {cluster} 近 30 天已有 {c30} 篇，上限 {limits.get('max_articles_30d')}"})
            selection_status = "skipped_quota"
            skip_reason = f"topic_cluster {cluster} saturated（30d {c30}/{limits.get('max_articles_30d')}）"

    if selection_status == "eligible" and category:
        target = (policy.get("business_category_targets") or {}).get(category)
        if target:
            c7 = stats["categoryCounts"]["d7"].get(category, 0)
            c14 = stats["categoryCounts"]["d14"].get(category, 0)
            if c7 >= int(target.get("max_articles_7d", 99)):
                value = -int(penalties_cfg.get("business_category_saturation_7d", 25))
                penalties.append({"type": "business_category_saturation_7d", "value": value, "reason": f"business_category {category} 近 7 天已有 {c7} 篇，上限 {target.get('max_articles_7d')}"})
                selection_status = "skipped_quota"
                skip_reason = f"business_category {category} saturated（7d {c7}/{target.get('max_articles_7d')}）"
            elif c14 >= int(target.get("max_articles_14d", 99)):
                value = -int(penalties_cfg.get("business_category_saturation_14d", 15))
                penalties.append({"type": "business_category_saturation_14d", "value": value, "reason": f"business_category {category} 近 14 天已有 {c14} 篇，上限 {target.get('max_articles_14d')}"})
                selection_status = "skipped_quota"
                skip_reason = f"business_category {category} saturated（14d {c14}/{target.get('max_articles_14d')}）"

    kw = candidate.get("primary_keyword")
    kw_count = stats["keywordCounts14d"].get(kw, 0) if kw else 0
    if kw_count > 0:
        penalties.append({"type": "primary_keyword_recent_14d", "value": -int(penalties_cfg.get("primary_keyword_recent_14d", 20)), "reason": f'primary_keyword "{kw}" 近 14 天已 {kw_count} 篇'})
        if selection_status == "eligible" and kw_count >= 2:
            selection_status = "skipped_recent_keyword"
            skip_reason = f'primary_keyword "{kw}" 近 14 天已 {kw_count} 篇（上限 2）'

    recent_for_dedupe = [{"topic": title} for title in stats["recentTitles"]] + [{"topic": row.get("topic"), "normalized_topic": row.get("normalized")} for row in stats["recentTopics"]]
    similarity_decision = decide_topic_dedupe(candidate, recent_for_dedupe, {}, {"ignoreKeywordThrottle": True})
    similarity = _similarity_value(similarity_decision)
    if similarity >= 0.35:
        penalties.append({"type": "similar_topic", "value": -int(penalties_cfg.get("similar_normalized_topic", 30)), "reason": f"与近 30 天文章/选题最高相似度 {similarity:.2f}"})
    if selection_status == "eligible" and similarity_decision.get("decision") in {"shadow_duplicate", "deferred_duplicate"}:
        selection_status = "skipped_duplicate"
        skip_reason = f"语义重复（similarity {similarity:.2f}，{similarity_decision.get('reason')}）"

    if category and (policy.get("business_category_targets") or {}).get(category):
        target = policy["business_category_targets"][category]
        total14 = max(1, int(stats.get("totalArticles14d") or 0))
        share = stats["categoryCounts"]["d14"].get(category, 0) / total14
        if share < float(target.get("target_share") or 0):
            bonuses.append({"type": "underrepresented_business_category", "value": int(bonuses_cfg.get("underrepresented_business_category", 15)), "reason": f"{category} 近 14 天占比 {share * 100:.0f}% < 目标 {float(target.get('target_share') or 0) * 100:.0f}%"})
            boost_key = f"{category}_boost_if_underrepresented"
            if bonuses_cfg.get(boost_key):
                bonuses.append({"type": boost_key, "value": int(bonuses_cfg[boost_key]), "reason": f"{category} 欠代表专项加分"})
    if cluster and not stats["clusterCounts"]["all"].get(cluster, 0):
        bonuses.append({"type": "first_article_in_topic_cluster", "value": int(bonuses_cfg.get("first_article_in_topic_cluster", 10)), "reason": f"主题簇 {cluster} 尚无文章"})
    if candidate.get("priority") == "P0":
        bonuses.append({"type": "high_business_fit", "value": int(bonuses_cfg.get("high_business_fit", 8)), "reason": "P0 优先级选题"})
    if candidate.get("content_type") in {"policy_update", "product_update"}:
        bonuses.append({"type": "fresh_source_policy_update", "value": int(bonuses_cfg.get("fresh_source_policy_update", 8)), "reason": f"时效型内容（{candidate.get('content_type')}）"})

    cv = candidate.get("content_value_score")
    breakdown = db.as_json(candidate.get("value_breakdown_json")) or {}
    if cv is None:
        cv, breakdown = heuristic_value_score(candidate, stats)
    cv = int(cv or 0)
    if selection_status == "eligible":
        if cv < 75:
            selection_status = "skipped_low_value"
            skip_reason = f"内容价值分 {cv} < 75（{breakdown.get('reason') or '痛点/可执行性/信息增量不足'}）"
        elif int(breakdown.get("sellerPainValue") or 99) + int(breakdown.get("actionability") or 99) < 22:
            selection_status = "skipped_low_value"
            skip_reason = f"痛点({breakdown.get('sellerPainValue')})+可执行性({breakdown.get('actionability')}) < 22，写出来没用"
        elif int(breakdown.get("sourceSupport") or 99) < 4:
            selection_status = "skipped_low_source_support"
            skip_reason = f"来源支撑 {breakdown.get('sourceSupport')}/10 过低，先 defer 等可核实来源"
    selection_score = max(0, round(cv * 0.55 + raw_score * 0.25 + sum(p["value"] for p in penalties) + sum(b["value"] for b in bonuses)))
    deferrable = selection_status in {"skipped_quota", "skipped_duplicate", "skipped_recent_keyword", "skipped_low_source_support"}
    return _decision_row(
        candidate,
        selection_score=selection_score,
        status=selection_status,
        reason=skip_reason,
        penalties=penalties,
        bonuses=bonuses,
        deferred_until=deferred_until if deferrable else None,
        similarity={"topic": round(similarity, 3)},
    )["decision"]


def select_topic_candidates(*, limit: int = 1, min_score: int = 80, category: str | None = None, dry_run: bool = False, engine_run_id: str | None = None, database: Any | None = None) -> dict[str, Any]:
    database = database or db.Database()
    ensure_value_scores(engine_run_id=engine_run_id, database=database)
    policy = portfolio_policy()
    stats = calculate_portfolio_stats(database=database)
    now = db.now()
    sql = """
        SELECT * FROM topic_candidates
        WHERE (status IN ('candidate', 'selected') OR (status = 'deferred' AND deferred_until IS NOT NULL AND deferred_until <= %s))
          AND score >= %s
          AND NOT EXISTS (
            SELECT 1 FROM article_writing_tasks aj
            WHERE aj.topic_candidate_id = topic_candidates.id
              AND aj.status IN ('pending', 'running', 'generated')
          )
    """
    params: list[Any] = [now, min_score]
    if category:
        sql += " AND category = %s"
        params.append(category)
    sql += " ORDER BY score DESC, created_at DESC LIMIT 80"
    pool = database.query(sql, params)

    decisions: list[dict[str, Any]] = []
    for candidate in pool:
        decisions.append({"candidate": candidate, "decision": calculate_selection_score(candidate, stats, policy)})

    eligible = sorted([item for item in decisions if item["decision"]["eligible"]], key=lambda item: (item["decision"]["selectionScore"], item["decision"]["rawScore"]), reverse=True)
    ineligible = [item for item in decisions if not item["decision"]["eligible"]]
    selected: list[dict[str, Any]] = []
    batch_skipped: list[dict[str, Any]] = []
    seen_clusters: set[str] = set()
    for item in eligible:
        candidate = item["candidate"]
        decision = item["decision"]
        cluster = candidate.get("topic_cluster")
        if len(selected) >= max(1, min(50, limit)):
            batch_skipped.append({"candidate": candidate, "decision": {**decision, "selectionStatus": "batch_skipped", "skipReason": "批次名额已满", "eligible": False}})
            continue
        if cluster and cluster in seen_clusters:
            batch_skipped.append({"candidate": candidate, "decision": {**decision, "selectionStatus": "batch_skipped", "skipReason": f"批内已选同主题簇 {cluster}", "eligible": False}})
            continue
        selected.append(item)
        if cluster:
            seen_clusters.add(cluster)

    if not dry_run:
        for item in selected:
            candidate = item["candidate"]
            decision = item["decision"]
            database.update("topic_candidates", {
                "status": "selected",
                "raw_score": decision["rawScore"],
                "selection_score": decision["selectionScore"],
                "selection_status": "selected",
                "selection_skip_reason": None,
                "deferred_until": None,
                "portfolio_debug_json": {"penalties": [], "bonuses": [], "similarity": {}},
                "updated_at": db.now(),
            }, "id = %s", [candidate["id"]])
        for item in ineligible:
            candidate = item["candidate"]
            decision = item["decision"]
            fields = {
                "raw_score": decision["rawScore"],
                "selection_score": decision["selectionScore"],
                "selection_status": decision["selectionStatus"],
                "selection_skip_reason": decision.get("skipReason"),
                "portfolio_debug_json": {"penalties": decision["penalties"], "bonuses": decision["bonuses"], "similarity": decision["similarity"]},
                "updated_at": db.now(),
            }
            if decision.get("deferredUntil"):
                fields.update({"status": "deferred", "deferred_until": decision["deferredUntil"]})
            database.update("topic_candidates", fields, "id = %s", [candidate["id"]])
        for item in batch_skipped:
            candidate = item["candidate"]
            decision = item["decision"]
            database.update("topic_candidates", {
                "raw_score": decision["rawScore"],
                "selection_score": decision["selectionScore"],
                "selection_status": "eligible",
                "portfolio_debug_json": {"penalties": decision["penalties"], "bonuses": decision["bonuses"], "similarity": decision["similarity"]},
                "updated_at": db.now(),
            }, "id = %s", [candidate["id"]])
    return {"selected": selected, "deferred": ineligible, "batchSkipped": batch_skipped, "decisions": decisions, "stats": stats, "policy": policy}


def select_topics_for_writing(*, limit: int = 1, min_score: int = 80, category: str | None = None, strategy: str = "balanced", dry_run: bool = False, engine_run_id: str | None = None, database: Any | None = None) -> dict[str, Any]:
    if strategy not in STRATEGIES:
        return {"ok": False, "error": f"strategy 非法: {strategy}"}
    database = database or db.Database()
    selected = select_topic_candidates(limit=limit, min_score=min_score, category=category, dry_run=dry_run, engine_run_id=engine_run_id, database=database)
    out = {
        "ok": True,
        "mode": "portfolio_balanced_python",
        "writingTaskCount": len(selected["selected"]),
        "selected": [_summary_row(item) for item in selected["selected"]],
        "deferred": [_summary_row(item) for item in selected["deferred"]],
        "batchSkipped": [_summary_row(item) for item in selected["batchSkipped"]],
    }
    if not selected["selected"]:
        return {
            **out,
            "ok": False,
            "error": f"没有符合条件的候选主题（score>={min_score}）" if not selected["decisions"] else f"高分候选全部被组合节流（deferred {len(selected['deferred'])} 个）",
            "hint": "先运行 topics:generate 或降低 --min-score",
        }
    if dry_run:
        return {**out, "dryRun": True, "strategy": strategy, "message": "dry-run：未创建写作任务，未更新候选状态"}

    writing_tasks = []
    now = db.now()
    for item in selected["selected"]:
        candidate = item["candidate"]
        decision = item["decision"]
        writing_task_id = db.make_id("task")
        database.insert("article_writing_tasks", {
            "id": writing_task_id,
            "engine_run_id": engine_run_id,
            "topic_candidate_id": candidate["id"],
            "topic": candidate["topic"],
            "primary_keyword": candidate.get("primary_keyword"),
            "secondary_keywords_json": _json_array(candidate.get("secondary_keywords_json")),
            "category": candidate.get("category"),
            "content_angle": candidate.get("content_angle"),
            "business_angle": candidate.get("business_angle"),
            "source_urls_json": _json_array(candidate.get("source_urls_json")),
            "strategy": strategy,
            "content_type": candidate.get("content_type"),
            "business_category": candidate.get("business_category"),
            "topic_cluster": candidate.get("topic_cluster"),
            "status": "pending",
            "created_at": now,
            "updated_at": now,
        })
        writing_tasks.append({
            "writingTaskId": writing_task_id,
            "topic": candidate["topic"],
            "primaryKeyword": candidate.get("primary_keyword"),
            "rawScore": decision["rawScore"],
            "selectionScore": decision["selectionScore"],
        })
    return {**out, "writingTaskCount": len(writing_tasks), "strategy": strategy, "writingTasks": writing_tasks}


def cluster_category_map() -> dict[str, str]:
    return {
        "alexa-shopping": "amazon_ai_shopping",
        "amazon-rufus": "amazon_ai_shopping",
        "ai-search-era": "amazon_ai_shopping",
        "listing-optimization": "listing_geo",
        "amazon-geo": "listing_geo",
        "cosmo-algorithm": "listing_geo",
        "traffic-decline": "listing_geo",
        "amazon-ppc": "ppc_acos",
        "ppc-acos": "ppc_acos",
        "product-research": "product_research",
        "product-opportunity": "product_research",
        "keyword-research": "keyword_intent",
        "keyword-intent": "keyword_intent",
        "review-qa": "review_qa",
        "account-compliance": "account_compliance",
        "fba-logistics": "fba_inventory",
        "brand-growth": "brand_growth",
        "ai-tools": "ai_tools",
        "marketplace-policy": "marketplace_policy",
    }


def portfolio_health_report(*, database: Any | None = None) -> dict[str, Any]:
    database = database or db.Database()
    policy = portfolio_policy()
    stats = calculate_portfolio_stats(database=database)
    diagnostics = policy.get("diagnostics") or {}
    total14 = max(1, int(stats.get("totalArticles14d") or 0))
    warnings: list[str] = []
    for cluster, count in stats["clusterCounts"]["d14"].items():
        share = count / total14
        threshold = float(diagnostics.get("warn_if_cluster_share_above") or 0.35)
        if share > threshold:
            warnings.append(f"topic_cluster {cluster} 近 14 天占比 {share * 100:.0f}%（{count}/{total14}，阈值 {threshold * 100:.0f}%）")
    for category, count in stats["categoryCounts"]["d14"].items():
        share = count / total14
        threshold = float(diagnostics.get("warn_if_category_share_above") or 0.45)
        if share > threshold:
            warnings.append(f"business_category {category} 近 14 天占比 {share * 100:.0f}%（{count}/{total14}，阈值 {threshold * 100:.0f}%）")
    selection_counts = _count_map(database.query("SELECT selection_status k, COUNT(*) c FROM topic_candidates WHERE selection_status IS NOT NULL GROUP BY selection_status"))
    deferred_rows = database.query("SELECT COUNT(*) c FROM topic_candidates WHERE status = 'deferred' AND deferred_until > %s", [db.now()])
    deferred_active = int((deferred_rows[0] if deferred_rows else {}).get("c") or 0)
    keyword_warnings: list[str] = []
    try:
        keywords = database.query("SELECT cluster, priority FROM config_keywords WHERE enabled = 1")
        mapping = cluster_category_map()
        by_cat: dict[str, int] = {}
        p0_by_cat: dict[str, int] = {}
        for row in keywords:
            cat = mapping.get(row.get("cluster"), "other")
            by_cat[cat] = by_cat.get(cat, 0) + 1
            if row.get("priority") == "P0":
                p0_by_cat[cat] = p0_by_cat.get(cat, 0) + 1
        total = max(1, len(keywords))
        ai_share = (by_cat.get("amazon_ai_shopping", 0) + by_cat.get("listing_geo", 0)) / total
        if ai_share > 0.35:
            keyword_warnings.append(f"关键词库 Amazon AI Shopping + Listing GEO 合计占比 {ai_share * 100:.0f}% > 35%")
        total_p0 = max(1, sum(p0_by_cat.values()))
        p0_threshold = float(diagnostics.get("warn_if_p0_keywords_category_share_above") or 0.4)
        for cat, count in p0_by_cat.items():
            if count / total_p0 > p0_threshold:
                keyword_warnings.append(f"P0 关键词 {count / total_p0 * 100:.0f}% 集中在 {cat}")
    except Exception:
        pass
    recommendations: list[str] = []
    if warnings:
        recommendations.append("近期产出集中度过高：组合选择器将自动 defer 饱和簇的高分候选，优先未饱和分类")
    if keyword_warnings:
        recommendations.append("关键词库存在结构性偏置：运行 contentflow keywords analyze 查看明细并调整 config/keywords.csv")
    missing = [cat for cat in ["ppc_acos", "product_research", "keyword_intent", "review_qa", "account_compliance"] if not stats["categoryCounts"]["d30"].get(cat)]
    if missing:
        recommendations.append(f"近 30 天零产出的业务分类: {' / '.join(missing)}")
    return {
        "recentBusinessCategoryDistribution": {"d7": stats["categoryCounts"]["d7"], "d14": stats["categoryCounts"]["d14"], "d30": stats["categoryCounts"]["d30"]},
        "recentTopicClusterDistribution": {"d14": stats["clusterCounts"]["d14"], "d30": stats["clusterCounts"]["d30"]},
        "deferredCandidates": deferred_active,
        "quotaSkippedCandidates": selection_counts.get("skipped_quota", 0),
        "duplicateSkippedCandidates": selection_counts.get("skipped_duplicate", 0),
        "recentKeywordSkippedCandidates": selection_counts.get("skipped_recent_keyword", 0),
        "selectionStatusCounts": selection_counts,
        "dominantClusterWarning": warnings,
        "keywordDistributionWarnings": keyword_warnings,
        "recommendations": recommendations,
    }


def _summary_row(item: dict[str, Any]) -> dict[str, Any]:
    candidate = item["candidate"]
    decision = item["decision"]
    return {
        "topic": candidate.get("topic"),
        "rawScore": decision["rawScore"],
        "contentValueScore": decision.get("contentValueScore"),
        "selectionScore": decision["selectionScore"],
        "contentType": candidate.get("content_type"),
        "businessCategory": candidate.get("business_category"),
        "topicCluster": candidate.get("topic_cluster"),
        "primaryKeyword": candidate.get("primary_keyword"),
        "selectionStatus": decision["selectionStatus"],
        "skipReason": decision.get("skipReason") or None,
    }
