from __future__ import annotations

from datetime import datetime
from typing import Any

from contentflow.core import db, trace

MODE_ACTION = {
    "start": "start_daily",
    "retry": "retry_daily",
    "rebuild": "rebuild_daily",
    "force": "force_daily",
}


def get_daily_key(date: datetime | None = None) -> str:
    date = date or datetime.now()
    return f"{date.year:04d}-{date.month:02d}-{date.day:02d}"


def get_today_run_status(*, daily_key: str | None = None, scope: str = "daily", db_client: Any | None = None) -> dict[str, Any]:
    database = db_client or db.Database()
    key = daily_key or get_daily_key()
    runs = database.query(
        "SELECT * FROM engine_runs WHERE daily_key = %s AND run_scope = %s ORDER BY is_active DESC, started_at DESC LIMIT 5",
        [key, scope],
    )
    active = next((row for row in runs if row.get("is_active")), None)
    return {"dailyKey": key, "scope": scope, "activeRun": active, "allRuns": runs}


def is_completed(status: str | None) -> bool:
    return status == "succeeded"


def is_retryable(status: str | None) -> bool:
    return status in {"failed", "partial"}


def can_start_daily(*, daily_key: str | None = None, mode: str = "start", db_client: Any | None = None) -> dict[str, Any]:
    status = get_today_run_status(daily_key=daily_key, db_client=db_client)
    key = status["dailyKey"]
    active = status["activeRun"]
    actions = {
        "start": active is None,
        "retry": bool(active) and is_retryable(active.get("status")),
        "rebuild": bool(active),
        "force": True,
    }
    if mode == "start":
        if not active:
            allowed, reason = True, f"当天（{key}）无 active daily run，可以 start"
        elif active.get("status") == "running":
            allowed, reason = False, f"当天已有 running 的 daily run（{active.get('id')}），请等待完成"
        elif is_completed(active.get("status")):
            allowed, reason = False, f"当天 daily run 已完成（{active.get('id')}），重复 start 不会创建新数据；如需重跑请用 rebuild"
        else:
            allowed, reason = False, f"当天 daily run 状态为 {active.get('status')}（{active.get('id')}），请用 retry 或 rebuild"
    elif mode == "retry":
        if not active:
            allowed, reason = False, "当天没有 daily run，请先 start"
        elif is_completed(active.get("status")):
            allowed, reason = False, "当天 daily run 已完成，无需 retry；如需重跑请用 rebuild"
        elif active.get("status") == "running":
            allowed, reason = False, "当天 daily run 仍在 running，不能 retry"
        else:
            allowed, reason = True, f"active run 状态 {active.get('status')}，允许 retry（跳过已成功数据）"
    elif mode == "rebuild":
        allowed = True
        reason = f"将归档旧 run {active.get('id')} 并完整重跑" if active else "当天无旧 run，rebuild 等价于 start"
    elif mode == "force":
        allowed, reason = True, "force 模式：创建额外 run（默认 is_active=false，高级操作）"
    else:
        allowed, reason = False, f"未知 mode: {mode}"
    return {"allowed": allowed, "reason": reason, "activeRun": active, "availableActions": actions}


def record_run_action(*, engine_run_id: str | None = None, daily_key: str | None = None, action: str, actor: str, trigger_source: str, request: Any = None, result: Any = None, status: str, error_message: str | None = None, db_client: Any | None = None) -> str:
    database = db_client or db.Database()
    action_id = db.make_id("runact")
    database.insert("run_actions", {
        "id": action_id,
        "engine_run_id": engine_run_id,
        "daily_key": daily_key,
        "action": action,
        "actor": actor or "cli",
        "trigger_source": trigger_source or "cli",
        "request_json": request,
        "result_json": result,
        "status": status,
        "error_message": error_message[:900] if error_message else None,
        "created_at": db.now(),
    })
    return action_id


def mark_run_superseded(*, old_run_id: str, new_run_id: str, reason: str, db_client: Any | None = None, trace_writer: trace.TraceWriter | None = None) -> None:
    database = db_client or db.Database()
    writer = trace_writer or trace.default_writer
    database.update("engine_runs", {"is_active": 0, "status": "superseded", "superseded_by": new_run_id, "finished_at": db.now()}, "id = %s", [old_run_id])
    writer.log_workflow_event(
        engine_run_id=new_run_id,
        event_type="status_transition",
        level="info",
        message=f"engine_run {old_run_id} → superseded: {reason}",
        related_type="engine_run",
        related_id=old_run_id,
        data={"fromStatus": "active", "toStatus": "superseded", "actor": "run_control"},
    )


def archive_run_data(*, engine_run_id: str, superseded_by: str, db_client: Any | None = None) -> dict[str, Any]:
    database = db_client or db.Database()
    now = db.now()
    warnings: list[str] = []
    counts = {"topicCandidates": 0, "articleWritingTasks": 0, "articles": 0, "versions": 0, "packages": 0, "channels": 0}

    database.update(
        "engine_runs",
        {"is_active": 0, "status": "superseded", "superseded_by": superseded_by, "finished_at": now},
        "id = %s",
        [engine_run_id],
    )

    for row in database.query("SELECT id, status FROM topic_candidates WHERE engine_run_id = %s AND status IN ('candidate', 'selected')", [engine_run_id]):
        database.update("topic_candidates", {"status": "archived", "updated_at": now}, "id = %s", [row["id"]])
        counts["topicCandidates"] += 1

    for row in database.query("SELECT id, status FROM article_writing_tasks WHERE engine_run_id = %s AND status IN ('pending', 'running', 'failed')", [engine_run_id]):
        database.update("article_writing_tasks", {"status": "cancelled", "updated_at": now}, "id = %s", [row["id"]])
        counts["articleWritingTasks"] += 1

    for article in database.query("SELECT id, status FROM articles WHERE engine_run_id = %s", [engine_run_id]):
        if article["status"] in {"approved_for_publish", "published"}:
            warnings.append(f"文章 {article['id']} 状态为 {article['status']}，不自动归档（需人工决定）")
            continue
        database.update("articles", {"status": "archived", "updated_at": now}, "id = %s", [article["id"]])
        counts["articles"] += 1

        for version in database.query("SELECT id, status FROM article_versions WHERE article_id = %s AND status != 'archived'", [article["id"]]):
            database.update("article_versions", {"status": "archived", "updated_at": now}, "id = %s", [version["id"]])
            counts["versions"] += 1
        for package in database.query("SELECT id, status FROM publish_packages WHERE article_id = %s AND status != 'superseded'", [article["id"]]):
            database.update("publish_packages", {"status": "superseded", "updated_at": now}, "id = %s", [package["id"]])
            counts["packages"] += 1
        for channel in database.query("SELECT id, status FROM channel_outputs WHERE article_id = %s AND status != 'archived'", [article["id"]]):
            database.update("channel_outputs", {"status": "archived", "updated_at": now}, "id = %s", [channel["id"]])
            counts["channels"] += 1

    return {"counts": counts, "warnings": warnings}
