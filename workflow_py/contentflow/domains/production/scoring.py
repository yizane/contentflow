from __future__ import annotations

from typing import Any

from contentflow.core import db
from contentflow.llm import model, prompts, validators

WEIGHTS = {
    "balanced": {"seo": 0.3, "geo": 0.3, "fact": 0.2, "businessFit": 0.1, "readability": 0.1},
    "seo_first": {"seo": 0.45, "geo": 0.15, "fact": 0.2, "businessFit": 0.1, "readability": 0.1},
    "geo_first": {"seo": 0.15, "geo": 0.45, "fact": 0.2, "businessFit": 0.1, "readability": 0.1},
}


def latest_version(database: Any, article_id: str) -> dict[str, Any] | None:
    rows = database.query("SELECT * FROM article_versions WHERE article_id = %s ORDER BY created_at DESC LIMIT 1", [article_id])
    return rows[0] if rows else None


def score_article(article: dict[str, Any], *, engine_run_id: str | None, strategy: str = "balanced", force: bool = False, database: Any | None = None, call_agent=model.call_agent) -> dict[str, Any]:
    database = database or db.Database()
    version = latest_version(database, article["id"])
    if not version or not version.get("article_markdown"):
        return {"ok": False, "articleId": article["id"], "error": "无版本正文"}
    if not force:
        existing = database.query("SELECT id FROM seo_geo_scores WHERE article_id = %s AND article_version_id = %s AND strategy = %s LIMIT 1", [article["id"], version["id"], strategy])
        if existing:
            return {"ok": True, "skipped": True, "articleId": article["id"]}
    result = call_agent(
        task_type="seo_geo_score",
        prompt=prompts.score_prompt(
            article=article,
            article_markdown=version["article_markdown"],
            article_json=db.as_json(version.get("article_json")) or {},
            fact_check=db.as_json(version.get("fact_check_json")),
            source_resolution=db.as_json(version.get("source_resolution_json")),
            strategy=strategy,
            weights=WEIGHTS[strategy],
        ),
        session_key=f"agent:main:seogeo-{article['id']}",
        engine_run_id=engine_run_id,
        article_id=article["id"],
        article_version_id=version["id"],
        db_client=database,
    )
    if not result.get("ok"):
        return {"ok": False, "articleId": article["id"], "error": result.get("error")}
    validation = validators.validate_score_set_data(result["data"])
    if not validation.ok:
        return {"ok": False, "articleId": article["id"], "error": "; ".join(validation.issues[:5])}
    seo = result["data"]["seo"]
    geo = result["data"]["geo"]
    dual = result["data"]["dual"]
    now = db.now()
    database.insert("seo_geo_scores", {
        "id": db.make_id("score"),
        "article_id": article["id"],
        "article_version_id": version["id"],
        "engine_run_id": engine_run_id,
        "strategy": dual.get("strategy"),
        "overall_score": round(float(dual.get("overallScore") or 0)),
        "seo_score": round(float(dual.get("seoScore") or 0)),
        "geo_score": round(float(dual.get("geoScore") or 0)),
        "fact_score": round(float(dual.get("factScore") or 0)),
        "business_fit_score": round(float(dual.get("businessFitScore") or 0)),
        "readability_score": round(float(dual.get("readabilityScore") or 0)),
        "recommendation": dual.get("recommendation"),
        "seo_json": seo,
        "geo_json": geo,
        "dual_json": dual,
        "created_at": now,
    })
    database.update("article_versions", {"seo_score_json": seo, "geo_score_json": geo, "dual_quality_json": dual, "seo_score": round(float(dual.get("seoScore") or 0)), "geo_score": round(float(dual.get("geoScore") or 0)), "updated_at": now}, "id = %s", [version["id"]])
    database.update("articles", {"seo_score": round(float(dual.get("seoScore") or 0)), "geo_score": round(float(dual.get("geoScore") or 0)), "updated_at": now}, "id = %s", [article["id"]])
    return {"ok": True, "skipped": False, "articleId": article["id"], "summary": {"overallScore": dual.get("overallScore"), "seoScore": dual.get("seoScore"), "geoScore": dual.get("geoScore")}}


def run_scores(*, article_id: str | None = None, slug: str | None = None, status: str | None = None, strategy: str = "balanced", limit: int = 10, force: bool = False, engine_run_id: str | None = None, database: Any | None = None, call_agent=model.call_agent) -> dict[str, Any]:
    if strategy not in WEIGHTS:
        return {"ok": False, "error": f"strategy 非法: {strategy}"}
    database = database or db.Database()
    selected_status = status or (None if article_id or slug else "ready_for_review")
    if article_id:
        articles = database.query("SELECT * FROM articles WHERE id = %s", [article_id])
    elif slug:
        articles = database.query(f"SELECT * FROM articles WHERE slug = %s ORDER BY created_at DESC LIMIT {max(1, min(100, limit))}", [slug])
    elif engine_run_id and selected_status:
        articles = database.query(f"SELECT * FROM articles WHERE status = %s AND engine_run_id = %s ORDER BY created_at DESC LIMIT {max(1, min(100, limit))}", [selected_status, engine_run_id])
    elif selected_status:
        articles = database.query(f"SELECT * FROM articles WHERE status = %s ORDER BY created_at DESC LIMIT {max(1, min(100, limit))}", [selected_status])
    else:
        articles = []
    if not articles:
        return {"ok": True, "scored": 0, "message": "没有匹配的文章"}
    results = [score_article(article, engine_run_id=engine_run_id, strategy=strategy, force=force, database=database, call_agent=call_agent) for article in articles]
    scored = len([r for r in results if r.get("ok") and not r.get("skipped")])
    skipped = len([r for r in results if r.get("skipped")])
    failed = len([r for r in results if not r.get("ok")])
    return {"ok": failed == 0, "strategy": strategy, "scored": scored, "skipped": skipped, "failed": failed, "results": results}
