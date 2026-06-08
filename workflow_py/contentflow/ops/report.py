from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from contentflow.core import db
from contentflow.domains.topics import selection as topic_selection

REQUIRED_CHANNELS = ["wechat", "douyin", "xiaohongshu"]

STEP_DISPLAY: dict[str, dict[str, str]] = {
    "sources_collect": {
        "name": "资料采集",
        "purpose": "抓取每日数据源，抽取正文，写入 source_observations/source_items。",
    },
    "topics_generate": {
        "name": "候选主题生成",
        "purpose": "把当日素材和历史素材交给模型，生成候选主题，并做来源相关性与去重。",
    },
    "topics_select": {
        "name": "选题入选与写作排队",
        "purpose": "用组合策略从候选主题里选出本轮要写的题目，创建写作任务。",
    },
    "articles_generate": {
        "name": "文章初稿生成",
        "purpose": "按入选题目生成文章、版本、视觉规划和质量初评。",
    },
    "articles_factcheck": {
        "name": "事实核查与来源门禁",
        "purpose": "核查正文事实，判断能否进入终审，或是否需要补来源/修订。",
    },
    "sources_fix": {
        "name": "来源补全与修订",
        "purpose": "为缺来源文章补证据、改写正文，并重新事实核查。",
    },
    "article_quality_score": {
        "name": "文章质量主评分",
        "purpose": "用主评分判定文章是否达到进入终审的质量线。",
    },
    "seo_geo_score": {
        "name": "SEO/GEO 辅助评分",
        "purpose": "给出搜索与 AI 引用友好度建议，不覆盖事实核查和质量门。",
    },
    "channels_generate": {
        "name": "渠道改写",
        "purpose": "把 ready 文章改写成公众号、抖音、小红书等渠道版本。",
    },
    "package_export": {
        "name": "发布包生成",
        "purpose": "整理正文、渠道稿、元数据和检查结果，形成待发布包。",
    },
    "review_mark": {
        "name": "人工终审",
        "purpose": "记录人工通过、退回、归档等终审动作。",
    },
    "db_list": {
        "name": "运行摘要",
        "purpose": "读取最新文章状态，作为本次运行的收尾摘要。",
    },
}


def describe_step(step_key: str | None, step_name: str | None = None) -> dict[str, str]:
    definition = STEP_DISPLAY.get(str(step_key or ""))
    if definition:
        return definition
    fallback = str(step_name or step_key or "unknown")
    return {"name": fallback, "purpose": "未登记的内部步骤。"}


def _cnt(rows: list[dict[str, Any]]) -> dict[str, int]:
    return {row["k"]: int(row["c"] or 0) for row in rows if row.get("k")}


def _safe_query(database: Any, sql: str, params: list[Any] | None = None, fallback: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    try:
        return database.query(sql, params or [])
    except Exception:
        return fallback or []


def _json(value: Any) -> Any:
    if isinstance(value, (dict, list)):
        return value
    if value is None:
        return None
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return None


def _ms(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _dt(value: Any) -> datetime | None:
    return value if isinstance(value, datetime) else None


def _usage(raw_summary: Any) -> dict[str, int]:
    raw = _json(raw_summary) or {}
    usage = raw.get("usage") or {}
    input_tokens = _ms(usage.get("inputTokens") or usage.get("prompt_tokens") or usage.get("input_tokens"))
    output_tokens = _ms(usage.get("outputTokens") or usage.get("completion_tokens") or usage.get("output_tokens"))
    total_tokens = _ms(usage.get("totalTokens") or usage.get("total_tokens") or input_tokens + output_tokens)
    return {"inputTokens": input_tokens, "outputTokens": output_tokens, "totalTokens": total_tokens, "durationMs": _ms(raw.get("durationMs"))}


def build_run_observability(*, run_id: str, database: Any | None = None) -> dict[str, Any]:
    database = database or db.Database()
    run_rows = database.query("SELECT id, daily_key, status, started_at, finished_at FROM engine_runs WHERE id = %s", [run_id])
    run = run_rows[0] if run_rows else {"id": run_id}
    steps = database.query(
        """
        SELECT id, step_key, step_name, step_order, status, started_at, finished_at, duration_ms,
               input_summary_json, output_summary_json, error_message
        FROM workflow_steps
        WHERE engine_run_id = %s
        ORDER BY step_order ASC, id ASC
        """,
        [run_id],
    )
    model_runs = database.query(
        """
        SELECT id, task_type, status, started_at, finished_at, raw_summary_json, error_message
        FROM model_runs
        WHERE engine_run_id = %s
        ORDER BY started_at ASC
        """,
        [run_id],
    )
    metrics = {
        step["id"]: {
            "modelCalls": 0,
            "failedModelCalls": 0,
            "inputTokens": 0,
            "outputTokens": 0,
            "totalTokens": 0,
            "modelDurationMs": 0,
            "tasks": {},
            "modelRunIds": [],
        }
        for step in steps
    }
    unmatched: list[dict[str, Any]] = []
    for model_run in model_runs:
        started_at = _dt(model_run.get("started_at"))
        usage = _usage(model_run.get("raw_summary_json"))
        matched = None
        for step in steps:
            step_start = _dt(step.get("started_at"))
            step_end = _dt(step.get("finished_at"))
            if step_start and step_end and started_at and step_start <= started_at <= step_end:
                matched = step
                break
        if not matched:
            unmatched.append({
                "id": model_run.get("id"),
                "taskType": model_run.get("task_type"),
                "status": model_run.get("status"),
                "startedAt": str(model_run.get("started_at")),
                **usage,
            })
            continue
        metric = metrics[matched["id"]]
        task_type = model_run.get("task_type") or "unknown"
        metric["modelCalls"] += 1
        metric["failedModelCalls"] += 1 if model_run.get("status") == "failed" else 0
        metric["inputTokens"] += usage["inputTokens"]
        metric["outputTokens"] += usage["outputTokens"]
        metric["totalTokens"] += usage["totalTokens"]
        metric["modelDurationMs"] += usage["durationMs"]
        metric["tasks"][task_type] = metric["tasks"].get(task_type, 0) + 1
        metric["modelRunIds"].append(model_run.get("id"))
    rows: list[dict[str, Any]] = []
    for step in steps:
        input_summary = _json(step.get("input_summary_json")) or {}
        output_summary = _json(step.get("output_summary_json")) or {}
        metric = metrics[step["id"]]
        display = describe_step(step.get("step_key"), step.get("step_name"))
        rows.append({
            "stepId": step.get("id"),
            "stepOrder": step.get("step_order"),
            "round": output_summary.get("round") or input_summary.get("round"),
            "stepKey": step.get("step_key"),
            "stepName": step.get("step_name"),
            "displayName": display["name"],
            "purpose": display["purpose"],
            "status": step.get("status"),
            "startedAt": str(step.get("started_at")),
            "finishedAt": str(step.get("finished_at")),
            "durationMs": _ms(step.get("duration_ms")),
            "modelCalls": metric["modelCalls"],
            "failedModelCalls": metric["failedModelCalls"],
            "modelDurationMs": metric["modelDurationMs"],
            "inputTokens": metric["inputTokens"],
            "outputTokens": metric["outputTokens"],
            "totalTokens": metric["totalTokens"],
            "tasks": metric["tasks"],
            "summaryCounts": {key: value for key, value in output_summary.items() if key.endswith("Count") or key in {"processed", "readyForReview", "stillNeedsSources", "failed", "succeeded", "writingTaskCount"}},
            "error": step.get("error_message"),
        })
    return {
        "runId": run_id,
        "dailyKey": run.get("daily_key"),
        "status": run.get("status"),
        "startedAt": str(run.get("started_at")),
        "finishedAt": str(run.get("finished_at")),
        "steps": rows,
        "unmatchedModelRuns": unmatched,
        "totals": {
            "stepDurationMs": sum(row["durationMs"] for row in rows),
            "modelDurationMs": sum(row["modelDurationMs"] for row in rows),
            "modelCalls": sum(row["modelCalls"] for row in rows) + len(unmatched),
            "inputTokens": sum(row["inputTokens"] for row in rows) + sum(row["inputTokens"] for row in unmatched),
            "outputTokens": sum(row["outputTokens"] for row in rows) + sum(row["outputTokens"] for row in unmatched),
            "totalTokens": sum(row["totalTokens"] for row in rows) + sum(row["totalTokens"] for row in unmatched),
        },
    }


def build_engine_report(*, run_id: str | None = None, since: str | None = None, database: Any | None = None) -> dict[str, Any]:
    database = database or db.Database()
    if run_id:
        engine_runs = database.query("SELECT * FROM engine_runs WHERE id = %s", [run_id])
    elif since:
        engine_runs = database.query("SELECT * FROM engine_runs WHERE started_at >= %s ORDER BY started_at DESC", [f"{since} 00:00:00"])
    else:
        engine_runs = database.query("SELECT * FROM engine_runs ORDER BY started_at DESC LIMIT 10")

    status_counts = _cnt(database.query("SELECT status k, COUNT(*) c FROM articles GROUP BY status ORDER BY c DESC"))
    ready_for_review = database.query("SELECT id, title, slug, quality_score, article_quality_score, seo_score, geo_score, fact_publish_readiness FROM articles WHERE status = 'ready_for_review' ORDER BY created_at DESC")
    needs_fact_sources = database.query("SELECT id, title, slug, quality_score FROM articles WHERE status = 'needs_fact_sources' ORDER BY created_at DESC")
    recent_articles = database.query("SELECT id, title, status, quality_score, article_quality_score, created_at FROM articles ORDER BY created_at DESC LIMIT 10")
    failed_model_runs = database.query("SELECT task_type, error_message, started_at FROM model_runs WHERE status = 'failed' ORDER BY started_at DESC LIMIT 20")
    packages = database.query("SELECT slug, status, ready_for_publish_package, updated_at FROM publish_packages ORDER BY updated_at DESC LIMIT 20")

    reviewables = database.query("SELECT id FROM articles WHERE status IN ('ready_for_review','reviewed','approved_for_publish')")
    complete_channel_set = 0
    missing_channels: list[dict[str, Any]] = []
    for article in reviewables:
        existing = [row["channel"] for row in database.query("SELECT channel FROM channel_outputs WHERE article_id = %s", [article["id"]])]
        missing = [channel for channel in REQUIRED_CHANNELS if channel not in existing]
        if missing:
            missing_channels.append({"articleId": article["id"], "missing": missing})
        else:
            complete_channel_set += 1

    scored = database.query(
        """
        SELECT a.id, a.title, s.seo_score, s.geo_score, s.overall_score, s.strategy, s.recommendation
        FROM articles a
        JOIN seo_geo_scores s ON s.id = (
          SELECT id FROM seo_geo_scores WHERE article_id = a.id ORDER BY created_at DESC LIMIT 1
        )
        """
    )
    avg = lambda arr: round(sum(arr) / len(arr)) if arr else None
    seo_geo_summary = {
        "scoredArticles": len(scored),
        "avgSeoScore": avg([int(row.get("seo_score") or 0) for row in scored]),
        "avgGeoScore": avg([int(row.get("geo_score") or 0) for row in scored]),
        "avgOverallScore": avg([int(row.get("overall_score") or 0) for row in scored]),
        "perArticle": [{"articleId": row["id"], "title": str(row.get("title") or "")[:40], "seo": row.get("seo_score"), "geo": row.get("geo_score"), "overall": row.get("overall_score"), "strategy": row.get("strategy"), "recommendation": row.get("recommendation")} for row in scored],
    }

    content_type_counts = _cnt(database.query("SELECT content_type k, COUNT(*) c FROM articles GROUP BY content_type ORDER BY c DESC"))
    business_category_counts = _cnt(database.query("SELECT business_category k, COUNT(*) c FROM articles GROUP BY business_category ORDER BY c DESC"))
    topic_cluster_counts = _cnt(database.query("SELECT topic_cluster k, COUNT(*) c FROM articles GROUP BY topic_cluster ORDER BY c DESC"))
    src_cat_counts = _cnt(database.query("SELECT business_category k, COUNT(*) c FROM source_items WHERE created_at >= DATE_SUB(NOW(3), INTERVAL 7 DAY) GROUP BY business_category ORDER BY c DESC"))
    underproduced = [{"businessCategory": key, "sourceItems7d": count, "articles": business_category_counts.get(key, 0)} for key, count in src_cat_counts.items() if count >= 10 and business_category_counts.get(key, 0) <= 1]
    backlog_by_category = _cnt(database.query("SELECT business_category k, COUNT(*) c FROM articles WHERE status = 'needs_fact_sources' GROUP BY business_category"))
    unclassified = {
        "sourceItems": int(database.query("SELECT COUNT(*) c FROM source_items WHERE content_type IS NULL")[0]["c"]),
        "topicCandidates": int(database.query("SELECT COUNT(*) c FROM topic_candidates WHERE content_type IS NULL")[0]["c"]),
        "articles": int(database.query("SELECT COUNT(*) c FROM articles WHERE content_type IS NULL")[0]["c"]),
    }
    taxonomy_summary = {
        "contentTypeCounts": content_type_counts,
        "businessCategoryCounts": business_category_counts,
        "topicClusterCounts": topic_cluster_counts,
        "sourceItemsByCategory7d": src_cat_counts,
        "underproducedCategories": underproduced,
        "backlogByCategory": backlog_by_category,
        "unclassified": unclassified,
    }

    aq_rows = database.query("SELECT id, title, article_quality_score, seo_score, geo_score, visual_plan_json FROM articles WHERE status != 'archived'")
    aq_scored = [row for row in aq_rows if row.get("article_quality_score") is not None]
    quality_overview = {
        "avgArticleQualityScore": avg([int(row.get("article_quality_score") or 0) for row in aq_scored]),
        "avgSeoScore": avg([int(row.get("seo_score") or 0) for row in aq_rows if row.get("seo_score")]),
        "avgGeoScore": avg([int(row.get("geo_score") or 0) for row in aq_rows if row.get("geo_score")]),
        "scoredArticles": len(aq_scored),
        "unscoredArticles": len(aq_rows) - len(aq_scored),
        "lowQualityArticles": [{"id": row["id"], "title": str(row.get("title") or "")[:40], "articleQualityScore": row.get("article_quality_score")} for row in aq_scored if int(row.get("article_quality_score") or 0) < 80],
        "visualPlanMissing": [{"id": row["id"], "title": str(row.get("title") or "")[:40]} for row in aq_rows if not db.as_json(row.get("visual_plan_json"))],
    }
    portfolio_health = topic_selection.portfolio_health_report(database=database)

    observation_counts = _cnt(_safe_query(database, f"SELECT observation_status k, COUNT(*) c FROM source_observations {'WHERE engine_run_id = %s' if run_id else ''} GROUP BY observation_status", [run_id] if run_id else []))
    topic_signals = _cnt(_safe_query(database, f"SELECT status k, COUNT(*) c FROM topic_signals {'WHERE engine_run_id = %s' if run_id else ''} GROUP BY status", [run_id] if run_id else []))
    topic_dedupe = _cnt(_safe_query(database, f"SELECT decision k, COUNT(*) c FROM topic_dedupe_records {'WHERE engine_run_id = %s' if run_id else ''} GROUP BY decision", [run_id] if run_id else []))
    canonical_count = int((_safe_query(database, "SELECT COUNT(*) c FROM source_canonical_items", fallback=[{"c": 0}])[0]).get("c") or 0)
    source_observation_coverage = {
        "observations": sum(observation_counts.values()),
        "newSources": observation_counts.get("new_source", 0),
        "seenSources": observation_counts.get("seen_source", 0),
        "reactivatedSources": observation_counts.get("reactivated_source", 0),
        "ignored": observation_counts.get("ignored", 0),
        "canonicalSourcesSeen": canonical_count,
        "topicSignalsByStatus": topic_signals,
        "topicDedupeByDecision": topic_dedupe,
    }
    lane_rows = _safe_query(
        database,
        """
        SELECT lane,
               COUNT(*) total,
               SUM(usage_status = 'unused') unused,
               SUM(usage_status = 'used') used,
               SUM(usage_status = 'expired_soft') softExpired,
               SUM(first_seen_at >= DATE_SUB(NOW(3), INTERVAL 72 HOUR)) fresh72h,
               SUM(first_seen_at >= DATE_SUB(NOW(3), INTERVAL 168 HOUR) OR reactivated_at >= DATE_SUB(NOW(3), INTERVAL 168 HOUR)) fresh7d,
               SUM(reactivated_at >= DATE_SUB(NOW(3), INTERVAL 168 HOUR)) reactivated,
               MAX(TIMESTAMPDIFF(DAY, first_seen_at, NOW(3))) oldestDays
        FROM source_canonical_items
        GROUP BY lane
        """,
    )
    observation_lanes = _cnt(_safe_query(database, f"SELECT source_lane k, COUNT(*) c FROM source_observations {'WHERE engine_run_id = %s' if run_id else ''} GROUP BY source_lane", [run_id] if run_id else []))
    prompt_today = _cnt(_safe_query(database, "SELECT lane k, COUNT(*) c FROM source_canonical_items WHERE times_in_prompt > 0 AND updated_at >= CURDATE() GROUP BY lane"))
    lane_by_name = {row.get("lane"): row for row in lane_rows}
    source_lanes = {
        "news": {
            "collected": observation_lanes.get("news", 0),
            "fresh72h": int((lane_by_name.get("news") or {}).get("fresh72h") or 0),
            "inPrompt": prompt_today.get("news", 0),
        },
        "policy": {
            "collected": observation_lanes.get("policy", 0),
            "fresh7d": int((lane_by_name.get("policy") or {}).get("fresh7d") or 0),
            "inPrompt": prompt_today.get("policy", 0),
            "reactivated": int((lane_by_name.get("policy") or {}).get("reactivated") or 0),
        },
        "knowledge": {
            "total": int((lane_by_name.get("knowledge") or {}).get("total") or 0),
            "unused": int((lane_by_name.get("knowledge") or {}).get("unused") or 0),
            "used": int((lane_by_name.get("knowledge") or {}).get("used") or 0),
            "softExpired": int((lane_by_name.get("knowledge") or {}).get("softExpired") or 0),
            "inPromptToday": prompt_today.get("knowledge", 0),
            "oldestUnusedDays": (lane_by_name.get("knowledge") or {}).get("oldestDays"),
        },
    }
    selected_run_id = run_id or ((engine_runs[0] or {}).get("id") if engine_runs else None)
    observability = build_run_observability(run_id=selected_run_id, database=database) if selected_run_id else None

    next_actions: list[str] = []
    if needs_fact_sources:
        next_actions.append(f"{len(needs_fact_sources)} 篇待补来源: contentflow sources fix --limit {len(needs_fact_sources)}")
    missing_total = unclassified["sourceItems"] + unclassified["topicCandidates"] + unclassified["articles"]
    if missing_total:
        next_actions.append(f"{missing_total} 条内容未分类: contentflow content classify --all --limit 500")
    if missing_channels:
        next_actions.append(f"{len(missing_channels)} 篇缺渠道: contentflow channels generate --status ready_for_review --missing-only")
    if ready_for_review:
        next_actions.append(f"{len(ready_for_review)} 篇待终审: contentflow review mark --article-id <id> --status approved_for_publish")
    if not next_actions:
        next_actions.append("流水线无积压，可运行 contentflow engine daily")

    report = {
        "ok": True,
        "generatedAt": db.now(),
        "filters": {"runId": run_id, "since": since},
        "engineRuns": [{"id": row.get("id"), "type": row.get("run_type"), "status": row.get("status"), "startedAt": str(row.get("started_at")), "topicsCollected": row.get("topics_collected"), "topicsSelected": row.get("topics_selected"), "articlesGenerated": row.get("articles_generated"), "factChecksCompleted": row.get("fact_checks_completed"), "channelOutputsGenerated": row.get("channel_outputs_generated")} for row in engine_runs],
        "statusCounts": status_counts,
        "recentArticles": [{**row, "created_at": str(row.get("created_at"))} for row in recent_articles],
        "readyForReview": ready_for_review,
        "needsFactSources": needs_fact_sources,
        "channelCoverage": {"totalReadyArticles": len(reviewables), "completeChannelSet": complete_channel_set, "missingChannels": missing_channels},
        "seoGeoSummary": seo_geo_summary,
        "failedModelRuns": [{"taskType": row.get("task_type"), "startedAt": str(row.get("started_at")), "error": str(row.get("error_message") or "")[:160]} for row in failed_model_runs],
        "taxonomySummary": taxonomy_summary,
        "contentTypeCounts": content_type_counts,
        "businessCategoryCounts": business_category_counts,
        "topicClusterCounts": topic_cluster_counts,
        "qualityOverview": quality_overview,
        "portfolioHealth": portfolio_health,
        "sourceObservationCoverage": source_observation_coverage,
        "sourceLanes": source_lanes,
        "observability": observability,
        "packages": [{"slug": row.get("slug"), "status": row.get("status"), "ready": bool(row.get("ready_for_publish_package"))} for row in packages],
        "nextActions": next_actions,
    }
    markdown = f"""# Flyfus 内容引擎生产报告

> {report['generatedAt']}

## 状态分布

{chr(10).join(f"- **{status}**: {count}" for status, count in status_counts.items()) or "-"}

## 待终审（{len(ready_for_review)}）

{chr(10).join(f"- {row.get('title')}（质量 {row.get('quality_score')} / 主评分 {row.get('article_quality_score') or '-'} / SEO {row.get('seo_score') or '-'} / GEO {row.get('geo_score') or '-'}）`{row.get('id')}`" for row in ready_for_review) or "- 无"}

## 文章质量优先

平均主评分 **{quality_overview['avgArticleQualityScore'] or '-'}**（已评 {quality_overview['scoredArticles']} 篇 / 未评 {quality_overview['unscoredArticles']} 篇）

## 数据源观察与去重

Observation: 新源 {source_observation_coverage['newSources']} / 重复观察 {source_observation_coverage['seenSources']} / reactivated {source_observation_coverage['reactivatedSources']}

## 下一步

{chr(10).join(f"{index + 1}. {item}" for index, item in enumerate(next_actions))}
"""
    report_id = db.make_id("report")
    database.insert("engine_reports", {"id": report_id, "engine_run_id": run_id, "report_json": report, "report_markdown": markdown, "created_at": db.now()})
    return {
        "ok": True,
        "reportId": report_id,
        "storedIn": "engine_reports (MySQL)",
        "statusCounts": status_counts,
        "qualityOverview": quality_overview,
        "sourceObservationCoverage": source_observation_coverage,
        "sourceLanes": source_lanes,
        "observability": observability,
        "contentTypeCounts": content_type_counts,
        "businessCategoryCounts": business_category_counts,
        "topicClusterCounts": topic_cluster_counts,
        "portfolioHealth": portfolio_health,
        "readyForReview": len(ready_for_review),
        "needsFactSources": len(needs_fact_sources),
        "channelCoverage": report["channelCoverage"],
        "seoGeoSummary": {"avgSeo": seo_geo_summary["avgSeoScore"], "avgGeo": seo_geo_summary["avgGeoScore"], "scored": seo_geo_summary["scoredArticles"]},
        "nextActions": next_actions,
    }
