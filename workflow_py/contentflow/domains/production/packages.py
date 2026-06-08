from __future__ import annotations

from typing import Any

from contentflow.core import db
from contentflow.domains.production import channels as channels_module


def _json_array(value: Any) -> list[Any]:
    parsed = db.as_json(value)
    return parsed if isinstance(parsed, list) else []


def latest_version(database: Any, article_id: str) -> dict[str, Any] | None:
    rows = database.query("SELECT * FROM article_versions WHERE article_id = %s ORDER BY created_at DESC LIMIT 1", [article_id])
    return rows[0] if rows else None


def find_articles(*, article_id: str | None = None, slug: str | None = None, status: str | None = None, limit: int = 10, database: Any | None = None) -> list[dict[str, Any]]:
    database = database or db.Database()
    if article_id:
        return database.query("SELECT * FROM articles WHERE id = %s", [article_id])
    if slug:
        return database.query(f"SELECT * FROM articles WHERE slug = %s ORDER BY created_at DESC LIMIT {max(1, min(100, limit))}", [slug])
    if status:
        return database.query(f"SELECT * FROM articles WHERE status = %s ORDER BY created_at DESC LIMIT {max(1, min(100, limit))}", [status])
    return []


def export_article(article: dict[str, Any], *, require_channels: bool = False, with_channels: bool = False, engine_run_id: str | None = None, database: Any | None = None, call_agent=channels_module.model.call_agent) -> dict[str, Any]:
    database = database or db.Database()
    version = latest_version(database, article["id"])
    if not version:
        return {"articleId": article["id"], "ok": False, "error": "无版本"}
    warnings: list[str] = []
    if with_channels:
        existing = [row["channel"] for row in database.query("SELECT channel FROM channel_outputs WHERE article_id = %s AND article_version_id = %s", [article["id"], version["id"]])]
        if any(channel not in existing for channel in channels_module.CHANNELS):
            result = channels_module.generate_channels_for_article(article, engine_run_id=engine_run_id, missing_only=True, force=False, database=database, call_agent=call_agent)
            if result["failed"]:
                warnings.append(f"{article['id']} 渠道补齐部分失败: {', '.join(item['channel'] for item in result['failed'])}")
    channel_rows = database.query("SELECT channel, title, content_markdown, content_json, status FROM channel_outputs WHERE article_id = %s ORDER BY channel", [article["id"]])
    existing_channels = [row["channel"] for row in channel_rows]
    missing_channels = [channel for channel in channels_module.CHANNELS if channel not in existing_channels]
    channel_status = {"required": channels_module.CHANNELS, "existing": existing_channels, "missing": missing_channels, "ready": not missing_channels}
    latest_score = database.query("SELECT * FROM seo_geo_scores WHERE article_id = %s ORDER BY created_at DESC LIMIT 1", [article["id"]])
    latest_score = latest_score[0] if latest_score else None
    latest_fact = database.query("SELECT must_fix_json FROM fact_checks WHERE article_id = %s ORDER BY created_at DESC LIMIT 1", [article["id"]])
    must_fix = _json_array(latest_fact[0].get("must_fix_json")) if latest_fact else []
    source_stats = database.query("SELECT resolved_status, COUNT(*) c FROM source_resolutions WHERE article_id = %s AND article_version_id = %s GROUP BY resolved_status", [article["id"], version["id"]])
    article_json = db.as_json(version.get("article_json")) or {}
    visual_plan = db.as_json(version.get("visual_plan_json")) or article_json.get("visualPlan") or []
    article_quality = db.as_json(version.get("article_quality_json"))
    ready = article.get("status") == "ready_for_review" and channel_status["ready"]
    metadata = {
        "articleId": article["id"],
        "title": article.get("title"),
        "slug": article.get("slug"),
        "status": article.get("status"),
        "contentType": article.get("content_type"),
        "businessCategory": article.get("business_category"),
        "topicCluster": article.get("topic_cluster"),
        "articleQualityScore": article.get("article_quality_score"),
        "visualPlanCount": len(visual_plan),
        "requiredVisuals": len([item for item in visual_plan if item.get("required")]),
        "hasVisualPlan": bool(visual_plan),
        "primaryKeyword": article.get("primary_keyword"),
        "qualityScore": article.get("quality_score"),
        "publishRecommendation": article.get("publish_recommendation"),
        "factOverallRisk": article.get("fact_overall_risk"),
        "factPublishReadiness": article.get("fact_publish_readiness"),
        "latestSeoScore": latest_score.get("seo_score") if latest_score else None,
        "latestGeoScore": latest_score.get("geo_score") if latest_score else None,
        "latestOverallScore": latest_score.get("overall_score") if latest_score else None,
        "scoreStrategy": latest_score.get("strategy") if latest_score else None,
        "sourceResolutionStatsLatest": {row["resolved_status"]: row["c"] for row in source_stats},
        "channelStatus": channel_status,
        "readyForPublishPackage": ready,
        "remainingMustFix": must_fix,
        "suggestedCommand": f"contentflow channels generate --article-id {article['id']} --missing-only" if missing_channels else None,
        "generatedAt": db.now(),
    }
    readme = f"""# 发布包：{article.get('title')}

- status: `{article.get('status')}` | 质量门 {article.get('quality_score')}/{article.get('publish_recommendation')} | 核查 {article.get('fact_overall_risk') or '-'}/{article.get('fact_publish_readiness') or '-'}
- SEO/GEO: {f"SEO {latest_score.get('seo_score')} / GEO {latest_score.get('geo_score')} / 综合 {latest_score.get('overall_score')}（{latest_score.get('strategy')}）" if latest_score else "（未评分）"}
- 渠道: {' / '.join(existing_channels) if existing_channels else '（无）'}{f" 缺失: {'/'.join(missing_channels)}" if missing_channels else " OK"}
- 可进入人工终审: {"是" if ready else "否"}

## 文章质量主评分

{f"{article.get('article_quality_score')}/100（{article_quality.get('qualityRecommendation') if article_quality else '-'}）" if article.get('article_quality_score') is not None else f"未评分：contentflow score article-quality --article-id {article['id']}"}

## 视觉规划

{chr(10).join(f"{index + 1}. [{item.get('visualType')}] {item.get('title')} - {item.get('description')}" for index, item in enumerate(visual_plan)) if visual_plan else "无"}

## 仍需人工检查项

{chr(10).join(f"{index + 1}. {item}" for index, item in enumerate(must_fix)) if must_fix else "无遗留 mustFix"}
"""
    channels_json = {
        row["channel"]: {"title": row.get("title"), "contentMarkdown": row.get("content_markdown"), "json": db.as_json(row.get("content_json")), "status": row.get("status")}
        for row in channel_rows
    }
    now = db.now()
    existing = database.query("SELECT id FROM publish_packages WHERE article_id = %s AND article_version_id = %s LIMIT 1", [article["id"], version["id"]])
    fields = {
        "slug": article.get("slug"),
        "status": article.get("status"),
        "metadata_json": metadata,
        "readme_markdown": readme,
        "article_markdown": version.get("article_markdown"),
        "article_json": article_json,
        "quality_json": db.as_json(version.get("quality_json")),
        "fact_check_json": db.as_json(version.get("fact_check_json")),
        "source_resolution_json": db.as_json(version.get("source_resolution_json")),
        "channels_json": channels_json,
        "visual_plan_json": visual_plan or None,
        "article_quality_json": article_quality,
        "ready_for_publish_package": 1 if ready else 0,
        "updated_at": now,
    }
    if existing:
        package_id = existing[0]["id"]
        database.update("publish_packages", fields, "id = %s", [package_id])
    else:
        package_id = db.make_id("pkg")
        database.insert("publish_packages", {"id": package_id, "article_id": article["id"], "article_version_id": version["id"], "created_at": now, **fields})
    result = {"articleId": article["id"], "ok": True, "packageId": package_id, "slug": article.get("slug"), "channelStatus": channel_status, "readyForPublishPackage": ready, "warnings": warnings}
    if require_channels and not channel_status["ready"]:
        result["incomplete"] = True
    return result


def run_package_export(*, article_id: str | None = None, slug: str | None = None, status: str | None = None, limit: int = 10, require_channels: bool = False, with_channels: bool = False, engine_run_id: str | None = None, database: Any | None = None, call_agent=channels_module.model.call_agent) -> dict[str, Any]:
    database = database or db.Database()
    articles = find_articles(article_id=article_id, slug=slug, status=status, limit=limit, database=database)
    if not articles:
        cond = article_id or slug or f"status={status or '(未指定)'}"
        return {"ok": True, "exported": 0, "message": f"没有符合条件的文章（{cond}）", "packages": []}
    packages = [export_article(article, require_channels=require_channels, with_channels=with_channels, engine_run_id=engine_run_id, database=database, call_agent=call_agent) for article in articles]
    out = {"ok": True, "exported": len([p for p in packages if p.get("ok")]), "packages": packages, "warnings": [w for p in packages for w in p.get("warnings", [])]}
    if require_channels:
        incomplete = [p for p in packages if p.get("ok") and not p.get("channelStatus", {}).get("ready")]
        if incomplete:
            out["incompletePackages"] = [{"slug": p.get("slug"), "missing": p.get("channelStatus", {}).get("missing")} for p in incomplete]
    return out
