from __future__ import annotations

from typing import Any

from contentflow.core import db
from contentflow.flow import runtime
from contentflow.llm import model, prompts, validators


def derive_fc_status(readiness: str | None) -> str:
    if readiness == "needs_fact_sources":
        return "needs_fact_sources"
    if readiness == "ready_after_minor_edits":
        return "ready_for_review"
    if readiness == "not_ready":
        return "fact_check_failed"
    return "article_validated"


def latest_version(database: Any, article_id: str) -> dict[str, Any] | None:
    rows = database.query("SELECT * FROM article_versions WHERE article_id = %s ORDER BY created_at DESC LIMIT 1", [article_id])
    return rows[0] if rows else None


def factcheck_single_article(article: dict[str, Any], *, engine_run_id: str | None, database: Any | None = None, call_agent=model.call_agent) -> dict[str, Any]:
    database = database or db.Database()
    version = latest_version(database, article["id"])
    if not version or not version.get("article_markdown"):
        return {"ok": False, "articleId": article["id"], "error": "无版本正文"}
    quality = db.as_json(version.get("quality_json")) or {"score": article.get("quality_score"), "publishRecommendation": article.get("publish_recommendation")}
    result = call_agent(
        task_type="fact_check",
        prompt=prompts.fact_check_prompt(article_markdown=version["article_markdown"], quality=quality, label=f"article: {article['id']}"),
        session_key=f"agent:main:factcheck-{article['id']}",
        engine_run_id=engine_run_id,
        article_id=article["id"],
        article_version_id=version["id"],
        db_client=database,
    )
    if not result.get("ok"):
        return {"ok": False, "articleId": article["id"], "error": result.get("error")}
    validation = validators.validate_fact_check_data(result["data"])
    if not validation.ok:
        return {"ok": False, "articleId": article["id"], "error": "; ".join(validation.issues[:5])}
    fact_check = result["data"]
    summary = validators.fact_check_summary(fact_check)
    now = db.now()
    new_status = derive_fc_status(fact_check.get("publishReadiness"))
    gate = runtime.decide_ready_gate(intended_status=new_status, score=article.get("article_quality_score"), score_ok=article.get("article_quality_score") is not None)
    if gate["gated"]:
        new_status = gate["status"]
    database.insert("fact_checks", {
        "id": db.make_id("factcheck"),
        "article_id": article["id"],
        "article_version_id": version["id"],
        "overall_risk": fact_check.get("overallRisk"),
        "publish_readiness": fact_check.get("publishReadiness"),
        "claims_count": summary["claims"],
        "high_risk_count": summary["highRisk"],
        "medium_risk_count": summary["mediumRisk"],
        "source_needed_count": summary["sourceNeeded"],
        "must_fix_count": summary["mustFix"],
        "must_fix_json": fact_check.get("mustFixBeforePublish") or [],
        "raw_json": fact_check,
        "created_at": now,
    })
    database.update("article_versions", {"fact_check_json": fact_check, "fact_publish_readiness": fact_check.get("publishReadiness"), "status": "fact_checked" if new_status == "article_validated" else new_status, "updated_at": now}, "id = %s", [version["id"]])
    database.update("articles", {"status": new_status, "fact_overall_risk": fact_check.get("overallRisk"), "fact_publish_readiness": fact_check.get("publishReadiness"), "updated_at": now}, "id = %s", [article["id"]])
    return {"ok": True, "articleId": article["id"], "articleStatus": new_status, "overallRisk": fact_check.get("overallRisk"), "publishReadiness": fact_check.get("publishReadiness"), **summary}


def factcheck_articles_for_review_gate(*, limit: int = 20, article_id: str | None = None, engine_run_id: str | None = None, database: Any | None = None, call_agent=model.call_agent) -> dict[str, Any]:
    database = database or db.Database()
    if article_id:
        articles = database.query("SELECT * FROM articles WHERE id = %s", [article_id])
    else:
        sql = "SELECT * FROM articles WHERE status = 'article_validated'"
        params: list[Any] = []
        if engine_run_id:
            sql += " AND engine_run_id = %s"
            params.append(engine_run_id)
        sql += f" ORDER BY created_at ASC LIMIT {max(1, min(50, limit))}"
        articles = database.query(sql, params)
    if not articles:
        return {"ok": False, "error": "没有待核查的文章（status=article_validated）"}
    results = [factcheck_single_article(article, engine_run_id=engine_run_id, database=database, call_agent=call_agent) for article in articles]
    succeeded = len([r for r in results if r.get("ok")])
    failed = len(results) - succeeded
    return {"ok": failed == 0, "succeeded": succeeded, "failed": failed, "results": results}
