from __future__ import annotations

from typing import Any

from contentflow.core import db
from contentflow.llm import model, prompts, validators

CHANNELS = ["wechat", "douyin", "xiaohongshu"]


def latest_version(database: Any, article_id: str) -> dict[str, Any] | None:
    rows = database.query("SELECT * FROM article_versions WHERE article_id = %s ORDER BY created_at DESC LIMIT 1", [article_id])
    return rows[0] if rows else None


def generate_channels_for_article(article: dict[str, Any], *, engine_run_id: str | None, missing_only: bool = False, force: bool = False, database: Any | None = None, call_agent=model.call_agent) -> dict[str, Any]:
    database = database or db.Database()
    version = latest_version(database, article["id"])
    if not version or not version.get("article_markdown"):
        return {"generated": [], "skipped": [], "failed": [{"channel": "*", "issues": ["无版本正文"]}]}
    existing_rows = database.query("SELECT channel FROM channel_outputs WHERE article_id = %s AND article_version_id = %s", [article["id"], version["id"]])
    existing = [row["channel"] for row in existing_rows]
    to_generate = list(CHANNELS) if force else [channel for channel in CHANNELS if channel not in existing]
    skipped = [channel for channel in CHANNELS if channel not in to_generate]
    if not to_generate:
        return {"generated": [], "skipped": CHANNELS, "failed": []}
    result = call_agent(
        task_type="channel_repurpose",
        prompt=prompts.channels_prompt(
            article_markdown=version["article_markdown"],
            article_json=db.as_json(version.get("article_json")) or {},
            quality=db.as_json(version.get("quality_json")),
            fact_check=db.as_json(version.get("fact_check_json")),
            channels=to_generate,
            label=f"article: {article['id']}",
        ),
        session_key=f"agent:main:channels-{article['id']}",
        engine_run_id=engine_run_id,
        article_id=article["id"],
        article_version_id=version["id"],
        db_client=database,
    )
    generated: list[str] = []
    failed: list[dict[str, Any]] = []
    now = db.now()
    for channel in to_generate:
        data = result.get("data", {}).get(channel) if result.get("ok") else None
        validation = validators.validate_channel_data(data, channel) if data else validators.ValidationResult(False, [result.get("error") or f"回复缺少 {channel}"])
        if not validation.ok:
            failed.append({"channel": channel, "issues": validation.issues[:3]})
            continue
        existing_row = database.query("SELECT id FROM channel_outputs WHERE article_id = %s AND article_version_id = %s AND channel = %s", [article["id"], version["id"], channel])
        fields = {
            "title": str(data.get("title") or "")[:510],
            "content_markdown": data.get("contentMarkdown"),
            "content_json": data,
            "status": "validated",
            "content_sha256": db.sha256(data.get("contentMarkdown")),
            "updated_at": now,
        }
        if existing_row and force:
            database.update("channel_outputs", fields, "id = %s", [existing_row[0]["id"]])
        elif not existing_row:
            database.insert("channel_outputs", {"id": db.make_id("chout"), "article_id": article["id"], "article_version_id": version["id"], "channel": channel, "created_at": now, **fields})
        generated.append(channel)
    return {"generated": generated, "skipped": skipped, "failed": failed}


def run_channels(*, article_id: str | None = None, slug: str | None = None, status: str | None = None, missing_only: bool = False, force: bool = False, limit: int = 20, engine_run_id: str | None = None, database: Any | None = None, call_agent=model.call_agent) -> dict[str, Any]:
    database = database or db.Database()
    if article_id:
        articles = database.query("SELECT * FROM articles WHERE id = %s", [article_id])
    elif slug:
        articles = database.query(f"SELECT * FROM articles WHERE slug = %s ORDER BY created_at DESC LIMIT {max(1, min(100, limit))}", [slug])
    else:
        selected_status = status or "ready_for_review"
        params: list[Any] = [selected_status]
        sql = "SELECT * FROM articles WHERE status = %s"
        if engine_run_id:
            sql += " AND engine_run_id = %s"
            params.append(engine_run_id)
        sql += f" ORDER BY created_at DESC LIMIT {max(1, min(100, limit))}"
        articles = database.query(sql, params)
    if not articles:
        return {"ok": True, "processedArticles": 0, "channelOutputsGenerated": 0, "skippedExisting": 0, "failed": 0, "items": [], "warnings": ["没有匹配的文章"], "errors": []}
    items = []
    errors: list[str] = []
    for article in articles:
        result = generate_channels_for_article(article, engine_run_id=engine_run_id, missing_only=missing_only, force=force, database=database, call_agent=call_agent)
        items.append({"articleId": article["id"], "slug": article.get("slug"), "generated": result["generated"], "skipped": result["skipped"], "failed": [item["channel"] for item in result["failed"]]})
        for item in result["failed"]:
            errors.append(f"{article['id']}/{item['channel']}: {'; '.join(item['issues'])}")
    generated = sum(len(item["generated"]) for item in items)
    skipped = sum(len(item["skipped"]) for item in items)
    failed = sum(len(item["failed"]) for item in items)
    return {"ok": failed == 0, "processedArticles": len(items), "channelOutputsGenerated": generated, "generated": generated, "skippedExisting": skipped, "failed": failed, "items": items, "warnings": [], "errors": errors}
