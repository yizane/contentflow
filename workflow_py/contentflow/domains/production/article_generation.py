from __future__ import annotations

from typing import Any

from contentflow.core import db
from contentflow.llm import model, prompts, validators
from contentflow.llm.providers import router


def _json_array(value: Any) -> list[Any]:
    parsed = db.as_json(value)
    return parsed if isinstance(parsed, list) else []


def _writing_task_data(writing_task: dict[str, Any]) -> dict[str, Any]:
    return {
        **writing_task,
        "secondaryKeywords": _json_array(writing_task.get("secondary_keywords_json")),
        "sourceUrls": _json_array(writing_task.get("source_urls_json")),
    }


def _unique_slug(database: Any, slug: str) -> str:
    base = slug
    suffix = 2
    while database.query("SELECT id FROM articles WHERE slug = %s LIMIT 1", [slug]):
        slug = f"{base}-{suffix}"
        suffix += 1
    return slug


def generate_article_from_writing_task(writing_task: dict[str, Any], *, engine_run_id: str | None, database: Any | None = None, call_agent=model.call_agent, max_attempts: int = 3) -> dict[str, Any]:
    database = database or db.Database()
    database.update("article_writing_tasks", {"status": "running", "updated_at": db.now()}, "id = %s", [writing_task["id"]])
    task_data = _writing_task_data(writing_task)
    failures: list[str] = []
    parsed = None
    gen_model_run_id: str | None = None
    for attempt in range(1, max_attempts + 1):
        result = call_agent(
            task_type="article_generation",
            prompt=prompts.article_generation_prompt(writing_task=task_data, attempt=attempt, previous_failures=failures),
            session_key=f"agent:main:content-{writing_task['id']}-a{attempt}",
            engine_run_id=engine_run_id,
            db_client=database,
        )
        if not result.get("ok"):
            failures = [result.get("error") or "model call failed"]
            continue
        candidate = result["data"]
        validation = validators.validate_article_data(candidate.get("article"), candidate.get("quality"))
        if validation.ok:
            parsed = candidate
            gen_model_run_id = result.get("modelRunId")
            break
        failures = validation.issues[:8]

    if not parsed:
        database.update("article_writing_tasks", {"status": "failed", "error_message": "; ".join(failures)[:900], "updated_at": db.now()}, "id = %s", [writing_task["id"]])
        return {"ok": False, "writingTaskId": writing_task["id"], "failures": failures[:5]}

    article = dict(parsed["article"])
    quality = parsed["quality"]
    article["slug"] = _unique_slug(database, article["slug"])
    now = db.now()
    article_id = db.make_id("article")
    version_id = db.make_id("ver")
    route = router.resolve_route("article_generation")
    article_status = "rejected" if quality.get("publishRecommendation") == "reject" else "article_validated"
    strategy = writing_task.get("strategy") or "balanced"
    classification = {
        "contentType": writing_task.get("content_type"),
        "businessCategory": writing_task.get("business_category"),
        "topicCluster": writing_task.get("topic_cluster"),
        "confidence": None,
        "reason": "继承自选题分类（topic_candidate → article_writing_task → article）",
    } if writing_task.get("content_type") else None

    database.insert("articles", {
        "id": article_id,
        "engine_run_id": engine_run_id,
        "topic_candidate_id": writing_task.get("topic_candidate_id"),
        "current_version_id": version_id,
        "title": article["articleTitle"][:510],
        "slug": article["slug"],
        "primary_keyword": article["primaryKeyword"],
        "secondary_keywords_json": article.get("secondaryKeywords") or [],
        "status": article_status,
        "quality_score": quality.get("score"),
        "publish_recommendation": quality.get("publishRecommendation"),
        "content_type": classification.get("contentType") if classification else None,
        "business_category": classification.get("businessCategory") if classification else None,
        "topic_cluster": classification.get("topicCluster") if classification else None,
        "visual_plan_json": article.get("visualPlan"),
        "created_at": now,
        "updated_at": now,
    })
    database.insert("article_versions", {
        "id": version_id,
        "article_id": article_id,
        "engine_run_id": engine_run_id,
        "article_writing_task_id": writing_task["id"],
        "topic_candidate_id": writing_task.get("topic_candidate_id"),
        "model_provider": route.provider_key,
        "model_name": route.model,
        "version_label": f"v1_{strategy}" if strategy != "balanced" else "v1",
        "generation_mode": "single_model",
        "strategy": strategy,
        "title": article["articleTitle"][:510],
        "slug": article["slug"],
        "status": "rejected" if article_status == "rejected" else "validated",
        "article_markdown": article["articleMarkdown"],
        "article_json": article,
        "quality_json": quality,
        "quality_score": quality.get("score"),
        "publish_recommendation": quality.get("publishRecommendation"),
        "content_type": classification.get("contentType") if classification else None,
        "business_category": classification.get("businessCategory") if classification else None,
        "topic_cluster": classification.get("topicCluster") if classification else None,
        "visual_plan_json": article.get("visualPlan"),
        "content_sha256": db.sha256(article["articleMarkdown"]),
        "created_at": now,
        "updated_at": now,
    })
    if gen_model_run_id:
        database.update("model_runs", {"article_id": article_id, "article_version_id": version_id}, "id = %s", [gen_model_run_id])
    if classification and classification.get("contentType"):
        database.insert("content_classifications", {
            "id": db.make_id("cls"),
            "entity_type": "articles",
            "entity_id": article_id,
            "content_type": classification.get("contentType"),
            "business_category": classification.get("businessCategory"),
            "topic_cluster": classification.get("topicCluster"),
            "confidence": classification.get("confidence"),
            "reason": classification.get("reason"),
            "classifier_type": "inherited",
            "model_run_id": None,
            "raw_json": None,
            "created_at": now,
        })
    database.insert("quality_reports", {
        "id": db.make_id("quality"),
        "article_id": article_id,
        "article_version_id": version_id,
        "score": quality.get("score"),
        "publish_recommendation": quality.get("publishRecommendation"),
        "facts_score": (quality.get("breakdown") or {}).get("facts"),
        "issues_json": quality.get("issues") or [],
        "required_fixes_json": quality.get("requiredFixes") or [],
        "raw_json": quality,
        "created_at": now,
    })
    database.update("article_writing_tasks", {"status": "generated", "updated_at": now}, "id = %s", [writing_task["id"]])
    if writing_task.get("topic_candidate_id"):
        database.update("topic_candidates", {"status": "generated", "updated_at": now}, "id = %s", [writing_task["topic_candidate_id"]])
    return {
        "ok": True,
        "writingTaskId": writing_task["id"],
        "articleId": article_id,
        "versionId": version_id,
        "title": article["articleTitle"],
        "qualityScore": quality.get("score"),
        "publishRecommendation": quality.get("publishRecommendation"),
    }


def generate_articles_from_writing_tasks(*, limit: int = 1, include_failed: bool = False, engine_run_id: str | None = None, database: Any | None = None, call_agent=model.call_agent) -> dict[str, Any]:
    database = database or db.Database()
    statuses = "('pending','failed')" if include_failed else "('pending')"
    sql = f"SELECT * FROM article_writing_tasks WHERE status IN {statuses}"
    params: list[Any] = []
    if engine_run_id:
        sql += " AND engine_run_id = %s"
        params.append(engine_run_id)
    sql += f" ORDER BY created_at ASC LIMIT {max(1, min(50, limit))}"
    writing_tasks = database.query(sql, params)
    results = [generate_article_from_writing_task(task, engine_run_id=engine_run_id, database=database, call_agent=call_agent) for task in writing_tasks]
    succeeded = len([result for result in results if result.get("ok")])
    failed = len(results) - succeeded
    return {"ok": failed == 0, "succeeded": succeeded, "failed": failed, "results": results}
