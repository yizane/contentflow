from __future__ import annotations

from datetime import timedelta
from typing import Any

from contentflow.core import db
from contentflow.flow import runtime
from contentflow.llm import model, prompts, validators

ARTICLE_QUALITY_MIN = 80


def latest_version(database: Any, article_id: str) -> dict[str, Any] | None:
    rows = database.query("SELECT * FROM article_versions WHERE article_id = %s ORDER BY created_at DESC LIMIT 1", [article_id])
    return rows[0] if rows else None


def score_article_quality(article: dict[str, Any], *, engine_run_id: str | None = None, force: bool = False, database: Any | None = None, call_agent=model.call_agent) -> dict[str, Any]:
    database = database or db.Database()
    version = latest_version(database, article["id"])
    if not version or not version.get("article_markdown"):
        return {"ok": False, "articleId": article["id"], "error": "无版本正文"}
    if not force and version.get("article_quality_score") is not None:
        return {"ok": True, "skipped": True, "articleId": article["id"], "articleQualityScore": version.get("article_quality_score")}
    since = runtime.engine_now_date(None) - timedelta(days=30)
    recent_titles = [
        row["title"] for row in database.query(
            "SELECT title FROM articles WHERE id != %s AND status != 'archived' AND created_at >= %s ORDER BY created_at DESC LIMIT 15",
            [article["id"], runtime.mysql_datetime_from_date(since)],
        )
    ]
    article_json = db.as_json(version.get("article_json")) or {}
    visual_plan = db.as_json(version.get("visual_plan_json")) or article_json.get("visualPlan") or []
    result = call_agent(
        task_type="article_quality_score",
        prompt=prompts.article_quality_prompt(
            article=article,
            article_markdown=version["article_markdown"],
            content_type=article.get("content_type"),
            recent_titles=recent_titles,
            visual_plan=visual_plan,
        ),
        session_key=f"agent:main:artquality-{article['id']}-{db.make_id('run')}",
        engine_run_id=engine_run_id,
        article_id=article["id"],
        article_version_id=version["id"],
        db_client=database,
    )
    if not result.get("ok"):
        return {"ok": False, "articleId": article["id"], "error": result.get("error")}
    validation = validators.validate_article_quality_data(result["data"])
    if not validation.ok:
        return {"ok": False, "articleId": article["id"], "error": "; ".join(validation.issues[:5])}
    quality = result["data"]
    breakdown = quality.get("breakdown") or {}
    score = round(float(quality.get("articleQualityScore") or 0))
    now = db.now()
    database.insert("article_quality_scores", {
        "id": db.make_id("aqscore"),
        "article_id": article["id"],
        "article_version_id": version["id"],
        "engine_run_id": engine_run_id,
        "article_quality_score": score,
        "seller_pain_fit": breakdown.get("sellerPainFit"),
        "actionability": breakdown.get("actionability"),
        "information_gain": breakdown.get("informationGain"),
        "originality": breakdown.get("originality"),
        "clarity": breakdown.get("clarity"),
        "evidence_use": breakdown.get("evidenceUse"),
        "business_usefulness": breakdown.get("businessUsefulness"),
        "recommendation": quality.get("qualityRecommendation"),
        "raw_json": quality,
        "created_at": now,
    })
    database.update("article_versions", {"article_quality_json": quality, "article_quality_score": score, "updated_at": now}, "id = %s", [version["id"]])
    database.update("articles", {"article_quality_score": score, "updated_at": now}, "id = %s", [article["id"]])
    return {
        "ok": True,
        "skipped": False,
        "articleId": article["id"],
        "articleQualityScore": score,
        "recommendation": quality.get("qualityRecommendation"),
        "mustFix": quality.get("mustFix") or [],
        "blocksReview": score < ARTICLE_QUALITY_MIN,
    }


def run_article_quality(*, status: str | None = None, article_id: str | None = None, all_articles: bool = False, limit: int = 10, force: bool = False, engine_run_id: str | None = None, database: Any | None = None, call_agent=model.call_agent) -> dict[str, Any]:
    if not status and not article_id and not all_articles:
        return {"ok": False, "error": "用法: --status <s> | --article-id <id> | --all，可加 --force"}
    database = database or db.Database()
    sql = "SELECT * FROM articles WHERE status NOT IN ('archived')"
    params: list[Any] = []
    if article_id:
        sql += " AND id = %s"
        params.append(article_id)
    if status:
        sql += " AND status = %s"
        params.append(status)
    sql += f" ORDER BY created_at DESC LIMIT {max(1, min(50, limit))}"
    articles = database.query(sql, params)
    if not articles:
        return {"ok": False, "error": "没有符合条件的文章"}
    results = [
        score_article_quality(article, engine_run_id=engine_run_id, force=force, database=database, call_agent=call_agent)
        for article in articles
    ]
    failed = len([r for r in results if not r.get("ok")])
    return {"ok": failed == 0, "qualityMin": ARTICLE_QUALITY_MIN, "count": len(results), "failed": failed, "results": results}
