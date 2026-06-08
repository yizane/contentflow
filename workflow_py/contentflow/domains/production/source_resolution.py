from __future__ import annotations

from typing import Any

from contentflow.core import db
from contentflow.domains.production import factcheck
from contentflow.llm import model, prompts, validators
from contentflow.llm.providers import router


def latest_version(database: Any, article_id: str) -> dict[str, Any] | None:
    rows = database.query("SELECT * FROM article_versions WHERE article_id = %s ORDER BY created_at DESC LIMIT 1", [article_id])
    return rows[0] if rows else None


def _find_articles(*, article_id: str | None, slug: str | None = None, status: str | None, limit: int, database: Any, engine_run_id: str | None = None) -> list[dict[str, Any]]:
    if article_id:
        return database.query("SELECT * FROM articles WHERE id = %s", [article_id])
    if slug:
        return database.query("SELECT * FROM articles WHERE slug = %s ORDER BY created_at DESC LIMIT 1", [slug])
    selected = status or "needs_fact_sources"
    params: list[Any] = [selected]
    where = "status = %s"
    if engine_run_id:
        where += " AND engine_run_id = %s"
        params.append(engine_run_id)
    return database.query(f"SELECT * FROM articles WHERE {where} ORDER BY created_at DESC LIMIT {max(1, min(50, limit))}", params)


def resolve_sources_for_article(article: dict[str, Any], *, engine_run_id: str | None = None, database: Any | None = None, call_agent=model.call_agent) -> dict[str, Any]:
    database = database or db.Database()
    version = latest_version(database, article["id"])
    if not version:
        return {"ok": False, "articleId": article["id"], "error": "无版本"}
    fact_check = db.as_json(version.get("fact_check_json"))
    if not fact_check:
        return {"ok": False, "articleId": article["id"], "error": "无 fact_check_json"}
    claims = [
        claim for claim in (fact_check.get("claims") or [])
        if claim.get("sourceNeeded") is True and claim.get("action") in {"cite_required", "soften"}
    ]
    must_fix = fact_check.get("mustFixBeforePublish") or []
    if not claims and not must_fix:
        return {"ok": False, "articleId": article["id"], "error": "没有待补来源事项"}
    article_json = db.as_json(version.get("article_json")) or {}
    result = call_agent(
        task_type="source_resolution",
        prompt=prompts.source_resolution_prompt(
            article=article,
            article_json=article_json,
            article_markdown=version.get("article_markdown") or "",
            claims=claims,
            must_fix=must_fix,
        ),
        session_key=f"agent:main:source-resolution-{article['id']}-{db.make_id('run')}",
        engine_run_id=engine_run_id,
        article_id=article["id"],
        article_version_id=version["id"],
        db_client=database,
    )
    if not result.get("ok"):
        return {"ok": False, "articleId": article["id"], "error": result.get("error")}
    validation = validators.validate_source_resolution_data(result["data"], article_id=article["id"])
    if not validation.ok:
        return {"ok": False, "articleId": article["id"], "error": "; ".join(validation.issues[:5])}
    resolution = result["data"]
    now = db.now()
    latest_fact_check = database.query("SELECT id FROM fact_checks WHERE article_id = %s ORDER BY created_at DESC LIMIT 1", [article["id"]])
    fact_check_id = latest_fact_check[0]["id"] if latest_fact_check else None
    for item in resolution.get("items") or []:
        source = item.get("source") or {}
        database.insert("source_resolutions", {
            "id": db.make_id("srcres"),
            "article_id": article["id"],
            "article_version_id": version["id"],
            "fact_check_id": fact_check_id,
            "claim_text": item.get("claim"),
            "claim_category": item.get("claimCategory"),
            "risk": item.get("risk"),
            "action": item.get("action"),
            "recommended_source_group": item.get("recommendedSourceGroup"),
            "resolved_status": item.get("resolvedStatus"),
            "source_url": source.get("url"),
            "source_title": str(source.get("title") or "")[:510] or None,
            "source_name": source.get("sourceName"),
            "source_type": source.get("sourceType"),
            "source_trust": source.get("sourceTrust"),
            "evidence_summary": item.get("evidenceSummary"),
            "suggested_rewrite": item.get("suggestedRewrite"),
            "notes": item.get("notes"),
            "raw_json": item,
            "created_at": now,
            "updated_at": now,
        })
    database.update("article_versions", {"source_resolution_json": resolution, "updated_at": now}, "id = %s", [version["id"]])
    return {"ok": True, "articleId": article["id"], "resolution": resolution, "summary": validators.source_resolution_summary(resolution)}


def run_source_resolution(*, article_id: str | None = None, limit: int = 1, engine_run_id: str | None = None, database: Any | None = None, call_agent=model.call_agent) -> dict[str, Any]:
    database = database or db.Database()
    articles = _find_articles(article_id=article_id, status=None, limit=limit, database=database, engine_run_id=engine_run_id)
    if not articles:
        return {"ok": False, "error": "没有目标文章"}
    results = [resolve_sources_for_article(article, engine_run_id=engine_run_id, database=database, call_agent=call_agent) for article in articles]
    return {"ok": any(r.get("ok") for r in results), "results": [{"articleId": r.get("articleId"), "ok": r.get("ok"), "summary": r.get("summary"), "error": r.get("error")} for r in results]}


def revise_article_with_resolution(article: dict[str, Any], resolution: dict[str, Any], *, engine_run_id: str | None = None, database: Any | None = None, call_agent=model.call_agent) -> dict[str, Any]:
    database = database or db.Database()
    version = latest_version(database, article["id"])
    if not version:
        return {"ok": False, "articleId": article["id"], "error": "无版本"}
    article_json = db.as_json(version.get("article_json")) or {}
    fact_check = db.as_json(version.get("fact_check_json")) or {}
    result = call_agent(
        task_type="article_revision",
        prompt=prompts.revision_prompt(
            article=article,
            article_json=article_json,
            resolution=resolution,
            must_fix=fact_check.get("mustFixBeforePublish") or [],
        ),
        session_key=f"agent:main:revision-{article['id']}-{db.make_id('run')}",
        engine_run_id=engine_run_id,
        article_id=article["id"],
        article_version_id=version["id"],
        db_client=database,
    )
    if not result.get("ok"):
        return {"ok": False, "articleId": article["id"], "error": result.get("error")}
    validation = validators.validate_revised_article_data(result["data"], article_json, resolution)
    if not validation.ok:
        return {"ok": False, "articleId": article["id"], "error": "; ".join(validation.issues[:5])}
    revised = result["data"]
    now = db.now()
    version_count = database.query("SELECT COUNT(*) c FROM article_versions WHERE article_id = %s", [article["id"]])
    count = int((version_count[0] if version_count else {}).get("c") or 0)
    new_version_id = db.make_id("ver")
    route = router.resolve_route("article_generation")
    database.insert("article_versions", {
        "id": new_version_id,
        "article_id": article["id"],
        "engine_run_id": engine_run_id,
        "article_writing_task_id": version.get("article_writing_task_id"),
        "topic_candidate_id": version.get("topic_candidate_id"),
        "model_provider": route.provider_key,
        "model_name": route.model,
        "version_label": f"v{count + 1}",
        "generation_mode": "fact_checked_revision",
        "strategy": version.get("strategy") or "balanced",
        "title": str(revised.get("articleTitle") or "")[:510],
        "slug": revised.get("slug"),
        "status": "generated",
        "article_markdown": revised.get("articleMarkdown"),
        "article_json": revised,
        "quality_json": db.as_json(version.get("quality_json")),
        "source_resolution_json": resolution,
        "quality_score": version.get("quality_score"),
        "publish_recommendation": version.get("publish_recommendation"),
        "content_type": version.get("content_type") or article.get("content_type"),
        "business_category": version.get("business_category") or article.get("business_category"),
        "topic_cluster": version.get("topic_cluster") or article.get("topic_cluster"),
        "visual_plan_json": revised.get("visualPlan") or db.as_json(version.get("visual_plan_json")),
        "content_sha256": db.sha256(revised.get("articleMarkdown")),
        "created_at": now,
        "updated_at": now,
    })
    updates = {"current_version_id": new_version_id, "updated_at": now}
    if revised.get("visualPlan"):
        updates["visual_plan_json"] = revised.get("visualPlan")
    database.update("articles", updates, "id = %s", [article["id"]])
    database.query("UPDATE source_resolutions SET article_version_id = %s, updated_at = %s WHERE article_id = %s AND article_version_id = %s", [new_version_id, now, article["id"], version["id"]])
    return {"ok": True, "articleId": article["id"], "versionId": new_version_id, "warnings": validation.warnings}


def run_revision(*, article_id: str | None = None, engine_run_id: str | None = None, database: Any | None = None, call_agent=model.call_agent) -> dict[str, Any]:
    database = database or db.Database()
    articles = _find_articles(article_id=article_id, status="needs_fact_sources", limit=1, database=database, engine_run_id=engine_run_id)
    if not articles:
        return {"ok": False, "error": "没有目标文章"}
    article = articles[0]
    version = latest_version(database, article["id"])
    resolution = db.as_json(version.get("source_resolution_json")) if version else None
    if not resolution:
        return {"ok": False, "articleId": article["id"], "error": "最新版本无 source_resolution_json，先运行 sources resolve"}
    result = revise_article_with_resolution(article, resolution, engine_run_id=engine_run_id, database=database, call_agent=call_agent)
    return {"ok": result.get("ok"), "articleId": article["id"], "versionId": result.get("versionId"), "error": result.get("error"), "warnings": result.get("warnings") or []}


def fix_article_sources(article: dict[str, Any], *, engine_run_id: str | None = None, database: Any | None = None, call_agent=model.call_agent) -> dict[str, Any]:
    database = database or db.Database()
    item = {"articleId": article["id"], "title": article.get("title"), "beforeStatus": article.get("status"), "afterStatus": article.get("status"), "sourceResolution": {}, "factCheck": {}}
    resolved = resolve_sources_for_article(article, engine_run_id=engine_run_id, database=database, call_agent=call_agent)
    if not resolved.get("ok"):
        return {**item, "failed": True, "error": f"来源补全失败: {resolved.get('error')}"}
    item["sourceResolution"] = resolved.get("summary") or {}
    revised = revise_article_with_resolution(article, resolved["resolution"], engine_run_id=engine_run_id, database=database, call_agent=call_agent)
    if not revised.get("ok"):
        return {**item, "failed": True, "error": f"修订失败: {revised.get('error')}", "warnings": revised.get("warnings") or []}
    checked = factcheck.factcheck_single_article(article, engine_run_id=engine_run_id, database=database, call_agent=call_agent)
    if not checked.get("ok"):
        return {**item, "failed": True, "error": f"重新核查失败: {checked.get('error')}", "warnings": revised.get("warnings") or []}
    item["factCheck"] = {"publishReadiness": checked.get("publishReadiness"), "mustFix": checked.get("mustFix")}
    item["afterStatus"] = checked.get("articleStatus")
    item["warnings"] = revised.get("warnings") or []
    return item


def run_sources_fix(*, article_id: str | None = None, slug: str | None = None, limit: int = 1, force: bool = False, engine_run_id: str | None = None, database: Any | None = None, call_agent=model.call_agent) -> dict[str, Any]:
    database = database or db.Database()
    articles = _find_articles(article_id=article_id, slug=slug, status=None if article_id or slug else "needs_fact_sources", limit=limit, database=database, engine_run_id=engine_run_id)
    explicit = bool(article_id or slug)
    if explicit and articles and articles[0].get("status") != "needs_fact_sources" and not force:
        return {"ok": True, "processed": 0, "message": f"文章 {articles[0]['id']} 状态是 {articles[0].get('status')}，重修请加 --force"}
    if not articles:
        return {"ok": True, "processed": 0, "message": "No needs_fact_sources articles found."}
    items = []
    warnings: list[str] = []
    errors: list[str] = []
    for article in articles:
        try:
            item = fix_article_sources(article, engine_run_id=engine_run_id, database=database, call_agent=call_agent)
        except Exception as exc:
            item = {"articleId": article["id"], "title": article.get("title"), "beforeStatus": article.get("status"), "afterStatus": article.get("status"), "failed": True, "error": str(exc)}
        if item.get("failed"):
            errors.append(f"{item.get('articleId')}: {item.get('error')}")
        warnings.extend([f"{item.get('articleId')}: {warning}" for warning in item.get("warnings") or []])
        if item.get("afterStatus") == "needs_fact_sources" and not item.get("failed"):
            warnings.append(f"{item.get('articleId')}: 修订后仍 needs_fact_sources")
        items.append(item)
    ready = len([item for item in items if item.get("afterStatus") == "ready_for_review"])
    still_needs = len([item for item in items if item.get("afterStatus") == "needs_fact_sources" and not item.get("failed")])
    failed = len([item for item in items if item.get("failed")])
    return {"ok": failed == 0, "processed": len(items), "readyForReview": ready, "stillNeedsSources": still_needs, "failed": failed, "items": items, "warnings": warnings, "errors": errors}
