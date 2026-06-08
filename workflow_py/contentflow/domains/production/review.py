from __future__ import annotations

from typing import Any

from contentflow.core import db
from contentflow.domains.production.article_quality import ARTICLE_QUALITY_MIN

ALLOWED_TARGETS = {"reviewed", "approved_for_publish", "archived", "rejected", "ready_for_review"}


def check_transition(from_status: str | None, to_status: str, note: str | None = None, article_quality_score: int | None = None) -> str | None:
    if to_status not in ALLOWED_TARGETS:
        return f"status 非法: {to_status}"
    if to_status in {"reviewed", "approved_for_publish"} and from_status not in {"ready_for_review", "reviewed"}:
        return f"只有 ready_for_review / reviewed 可进入 {to_status}（当前: {from_status}）"
    if to_status == "ready_for_review" and from_status != "reviewed":
        return f"只能从 reviewed 回退（当前: {from_status}）"
    if to_status == "archived" and from_status == "published":
        return "published 不能归档"
    if to_status == "rejected" and not note:
        return "rejected 必须带 --note"
    if to_status in {"reviewed", "approved_for_publish"} and article_quality_score is not None and article_quality_score < ARTICLE_QUALITY_MIN:
        action = "通过复审" if to_status == "reviewed" else "批准发布"
        return f"文章质量主评分 {article_quality_score} < {ARTICLE_QUALITY_MIN}，不得{action}"
    return None


def find_article(*, article_id: str | None = None, slug: str | None = None, database: Any | None = None) -> dict[str, Any] | None:
    database = database or db.Database()
    if article_id:
        rows = database.query("SELECT * FROM articles WHERE id = %s LIMIT 1", [article_id])
    elif slug:
        rows = database.query("SELECT * FROM articles WHERE slug = %s ORDER BY created_at DESC LIMIT 1", [slug])
    else:
        rows = []
    return rows[0] if rows else None


def mark_review(*, article_id: str | None = None, slug: str | None = None, status: str, note: str | None = None, dry_run: bool = False, actor: str = "cli", database: Any | None = None) -> dict[str, Any]:
    database = database or db.Database()
    article = find_article(article_id=article_id, slug=slug, database=database)
    if not article:
        return {"ok": False, "error": "未找到文章"}
    violation = check_transition(article.get("status"), status, note, article.get("article_quality_score"))
    if violation:
        return {"ok": False, "articleId": article["id"], "beforeStatus": article.get("status"), "requestedStatus": status, "error": violation}
    now = db.now()
    database.insert("review_actions", {
        "id": db.make_id("review"),
        "article_id": article["id"],
        "before_status": article.get("status"),
        "after_status": status,
        "action": "mark",
        "note": note,
        "actor": actor,
        "dry_run": 1 if dry_run else 0,
        "created_at": now,
    })
    if dry_run:
        return {"ok": True, "dryRun": True, "articleId": article["id"], "beforeStatus": article.get("status"), "afterStatus": status, "message": "dry-run：转换合法，未修改状态（审计已记 dry_run=1）"}
    database.update("articles", {"status": status, "updated_at": now}, "id = %s", [article["id"]])
    database.insert("status_transitions", {
        "id": db.make_id("st"),
        "entity_type": "article",
        "entity_id": article["id"],
        "engine_run_id": None,
        "from_status": article.get("status"),
        "to_status": status,
        "reason": note or "manual review mark",
        "actor": actor,
        "data_json": None,
        "created_at": now,
    })
    return {"ok": True, "articleId": article["id"], "beforeStatus": article.get("status"), "afterStatus": status, "note": note}
