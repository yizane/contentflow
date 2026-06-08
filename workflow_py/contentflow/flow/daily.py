from __future__ import annotations

import os
from typing import Any

from contentflow.core import config, db, trace
from contentflow.flow import run_control, runtime
from .steps import PythonStepBackend, StepRunner


def _scalar_count(database: Any, sql: str, params: list[Any]) -> int:
    rows = database.query(sql, params)
    if not rows:
        return 0
    return int(next(iter(rows[0].values())) or 0)


def count_ready_for_review(database: Any, engine_run_id: str) -> int:
    return _scalar_count(database, "SELECT COUNT(*) c FROM articles WHERE engine_run_id = %s AND status = 'ready_for_review'", [engine_run_id])


def count_quality_failed(database: Any, engine_run_id: str) -> int:
    return _scalar_count(database, "SELECT COUNT(*) c FROM articles WHERE engine_run_id = %s AND status = 'needs_quality_revision'", [engine_run_id])


def count_needs_fact_sources(database: Any, engine_run_id: str) -> int:
    return _scalar_count(database, "SELECT COUNT(*) c FROM articles WHERE engine_run_id = %s AND status = 'needs_fact_sources'", [engine_run_id])


def count_pending_writing_tasks(database: Any, engine_run_id: str) -> int:
    return _scalar_count(database, "SELECT COUNT(*) c FROM article_writing_tasks WHERE engine_run_id = %s AND status = 'pending'", [engine_run_id])


def _next_daily_key(daily_key: str) -> str:
    from datetime import datetime, timedelta

    return (datetime.strptime(daily_key, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")


def count_retry_reusable_writing_tasks(database: Any, args: runtime.BatchArgs) -> int:
    if not args.retry or not args.daily_key:
        return 0
    start = f"{args.daily_key} 00:00:00"
    end = f"{_next_daily_key(args.daily_key)} 00:00:00"
    return _scalar_count(database, "SELECT COUNT(*) c FROM article_writing_tasks WHERE status IN ('pending', 'failed') AND created_at >= %s AND created_at < %s", [start, end])


def claim_retry_reusable_writing_tasks(database: Any, args: runtime.BatchArgs, engine_run_id: str) -> int:
    if not args.retry or not args.daily_key:
        return 0
    start = f"{args.daily_key} 00:00:00"
    end = f"{_next_daily_key(args.daily_key)} 00:00:00"
    writing_tasks = database.query(
        f"SELECT id FROM article_writing_tasks WHERE status IN ('pending', 'failed') AND created_at >= %s AND created_at < %s ORDER BY created_at ASC LIMIT {args.max_attempts}",
        [start, end],
    )
    now = db.now()
    for task in writing_tasks:
        database.update("article_writing_tasks", {"engine_run_id": engine_run_id, "updated_at": now}, "id = %s", [task["id"]])
    return len(writing_tasks)


def _ensure_engine_run(database: Any, *, engine_run_id: str, args: runtime.BatchArgs) -> None:
    existing = database.query("SELECT id FROM engine_runs WHERE id = %s LIMIT 1", [engine_run_id])
    data = {
        "run_type": args.run_type,
        "status": "running",
        "started_at": db.now(),
        "daily_key": args.daily_key,
        "run_scope": args.run_scope,
        "run_mode": args.run_mode,
        "is_active": args.is_active,
        "triggered_by": args.triggered_by,
        "trigger_source": args.trigger_source,
    }
    if existing:
        database.update("engine_runs", data, "id = %s", [engine_run_id])
    else:
        database.insert("engine_runs", {"id": engine_run_id, **data})


def _finalize_engine_run(database: Any, engine_run_id: str, data: dict[str, Any]) -> None:
    last_error: Exception | None = None
    for _attempt in range(2):
        try:
            database.update("engine_runs", data, "id = %s", [engine_run_id])
            return
        except Exception as exc:
            last_error = exc
    raise last_error or RuntimeError("engine_runs final update failed")


def _failed_batch_summary(*, args: runtime.BatchArgs, engine_run_id: str, error: Exception, finalization_error: Exception | None = None) -> dict[str, Any]:
    errors = [str(error)[:900]]
    if finalization_error:
        errors.append(f"finalize failed: {str(finalization_error)[:900]}")
    return {
        "ok": False,
        "engineRunId": engine_run_id,
        "runner": "python",
        "targetReady": runtime.resolved_target_ready(args),
        "maxAttempts": args.max_attempts,
        "businessOutcome": "technical_failed",
        "topicsCollected": 0,
        "topicsSelected": 0,
        "articlesGenerated": 0,
        "articlesValidated": 0,
        "factChecksCompleted": 0,
        "channelOutputsGenerated": 0,
        "attemptedWritingTasks": 0,
        "readyCount": 0,
        "qualityFailedCount": 0,
        "warnings": [],
        "errors": errors,
        "nextActions": ["检查 MySQL 连接后使用 contentflow engine daily --mode retry 或 --mode rebuild"],
    }


def run_batch(args: runtime.BatchArgs, *, database: Any | None = None, step_runner: StepRunner | None = None) -> dict[str, Any]:
    if not args.dry_run:
        database = database or db.Database()
        if not args.run_id:
            args.run_id = db.make_run_id("engine")
    try:
        return _run_batch_impl(args, database=database, step_runner=step_runner)
    except Exception as exc:
        engine_run_id = args.run_id or db.make_run_id("engine")
        finalization_error: Exception | None = None
        try:
            if database is not None:
                summary = _failed_batch_summary(args=args, engine_run_id=engine_run_id, error=exc)
                _finalize_engine_run(database, engine_run_id, {
                    "status": "failed",
                    "finished_at": db.now(),
                    "summary_json": summary,
                    "error_message": str(exc)[:800],
                })
                return summary
        except Exception as finish_exc:
            finalization_error = finish_exc
        return _failed_batch_summary(args=args, engine_run_id=engine_run_id, error=exc, finalization_error=finalization_error)


def _run_batch_impl(args: runtime.BatchArgs, *, database: Any | None = None, step_runner: StepRunner | None = None) -> dict[str, Any]:
    if args.engine_now:
        os.environ["ENGINE_NOW"] = args.engine_now

    policy = config.read_yaml("production_policy")
    max_limit = int(((policy.get("batch_limits") or {}).get("max_limit_without_force")) or 5)
    if args.limit > max_limit and not args.force:
        return {"ok": False, "error": f"--limit {args.limit} 超过生产上限 {max_limit}，确需批量请加 --force。"}
    if args.dry_run:
        return {"ok": True, "dryRun": True, "runner": "python", "plan": runtime.build_batch_dry_run_plan(args), "message": "dry-run：参数合法，未执行"}

    database = database or db.Database()
    engine_run_id = args.run_id or db.make_run_id("engine")
    writer = trace.TraceWriter(db_client=database)
    runner = step_runner or StepRunner(trace_writer=writer, backend=PythonStepBackend(database=database))
    target_ready = runtime.resolved_target_ready(args)
    warnings: list[str] = []
    errors: list[str] = []
    counts = {
        "topicsCollected": 0,
        "topicsSelected": 0,
        "articlesGenerated": 0,
        "articlesValidated": 0,
        "factChecksCompleted": 0,
        "channelOutputsGenerated": 0,
        "attemptedWritingTasks": 0,
        "readyCount": 0,
        "qualityFailedCount": 0,
    }
    dedupe_rejected = 0
    seo_geo_scored = 0
    reusable_writing_tasks = 0

    _ensure_engine_run(database, engine_run_id=engine_run_id, args=args)
    writer.log_workflow_event(
        engine_run_id=engine_run_id,
        event_type="engine_started",
        level="info",
        message=f"engine {args.run_type} 启动（target {target_ready}, limit {args.limit}, strategy {args.strategy}）",
        data={"limit": args.limit, "targetReady": target_ready, "maxAttempts": args.max_attempts, "minScore": args.min_score, "strategy": args.strategy, "engineNow": args.engine_now},
    )

    if args.retry:
        reusable_writing_tasks = count_retry_reusable_writing_tasks(database, args)
        if reusable_writing_tasks > 0:
            claimed = claim_retry_reusable_writing_tasks(database, args, engine_run_id)
            warnings.append(f"retry：接管当天 {claimed} 个未完成写作任务，跳过资料采集、候选主题生成和选题入队")
            counts["topicsSelected"] += claimed
            runner.run_step("sources:collect", engine_run_id=engine_run_id, skipped=True)
            runner.run_step("topics:generate", engine_run_id=engine_run_id, skipped=True)
            runner.run_step("topics:select", engine_run_id=engine_run_id, skipped=True)

    if not (args.retry and reusable_writing_tasks > 0):
        collect = runner.run_step("sources:collect", [], engine_run_id)
        if collect.ok and collect.result:
            summary = collect.result.get("summary") or {}
            counts["topicsCollected"] = int(summary.get("total") or 0)
            warnings.extend((collect.result.get("warnings") or [])[:8])
        else:
            errors.append(f"sources:collect: {collect.error}")

        topic_gen = runner.run_step("topics:generate", [], engine_run_id)
        if topic_gen.ok and topic_gen.result:
            dedupe_rejected = int(topic_gen.result.get("dedupeRejected") or 0)
        elif not topic_gen.ok:
            errors.append(f"topics:generate: {topic_gen.error}")

    attempts = 0
    no_more_candidates = False
    while attempts < args.max_attempts:
        counts["readyCount"] = count_ready_for_review(database, engine_run_id)
        if counts["readyCount"] >= target_ready:
            break

        pending = count_pending_writing_tasks(database, engine_run_id)
        if pending == 0:
            topic_selection = runner.run_step("topics:select", ["--limit", str(args.limit), "--min-score", str(args.min_score), "--strategy", args.strategy], engine_run_id)
            writing_task_count = int((topic_selection.result or {}).get("writingTaskCount") or 0)
            if topic_selection.ok and writing_task_count > 0:
                counts["topicsSelected"] += writing_task_count
            else:
                no_more_candidates = True
                warnings.append(f"候选不足：ready {counts['readyCount']}/{target_ready}，无法继续补位")
                if not topic_selection.ok:
                    errors.append(f"topics:select: {topic_selection.error}")
                break

        include_failed = args.retry and reusable_writing_tasks > 0 and attempts == 0
        article_args = ["--limit", str(args.limit), *(["--include-failed"] if include_failed else [])]
        article_run = runner.run_step("articles:generate", article_args, engine_run_id)
        if not article_run.result:
            errors.append(f"articles:generate: {article_run.error}")
            break
        attempted = int(article_run.result.get("succeeded") or 0) + int(article_run.result.get("failed") or 0)
        generated_ok = int(article_run.result.get("succeeded") or 0)
        attempts += attempted
        counts["attemptedWritingTasks"] += attempted
        counts["articlesGenerated"] += attempted
        counts["articlesValidated"] += generated_ok
        for result in article_run.result.get("results") or []:
            if not result.get("ok"):
                failures = "; ".join(result.get("failures") or [])
                warnings.append(f"写作任务 {result.get('writingTaskId')}: {failures[:200]}")
        if attempted == 0:
            warnings.append("文章初稿生成未处理任何写作任务，停止补位")
            break

        if generated_ok > 0:
            fc = runner.run_step("articles:factcheck", ["--limit", str(max(args.limit, target_ready))], engine_run_id)
            if fc.result:
                counts["factChecksCompleted"] += int(fc.result.get("succeeded") or 0)
                for result in fc.result.get("results") or []:
                    if not result.get("ok"):
                        errors.append(f"fact check {result.get('articleId')}: {result.get('error')}")
            elif not fc.ok:
                errors.append(f"articles:factcheck: {fc.error}")
            if counts["readyCount"] < target_ready and count_needs_fact_sources(database, engine_run_id) > 0:
                fix = runner.run_step("sources:fix", ["--limit", str(max(args.limit, target_ready))], engine_run_id)
                if fix.result:
                    for result in fix.result.get("items") or []:
                        if result.get("failed"):
                            warnings.append(f"sources:fix {result.get('articleId')}: {str(result.get('error') or '')[:200]}")
                if not fix.ok:
                    errors.append(f"sources:fix: {fix.error or (fix.result or {}).get('error') or '补来源失败'}")
        else:
            runner.run_step("articles:factcheck", engine_run_id=engine_run_id, skipped=True)

        counts["qualityFailedCount"] = count_quality_failed(database, engine_run_id)

    counts["readyCount"] = count_ready_for_review(database, engine_run_id)
    counts["qualityFailedCount"] = count_quality_failed(database, engine_run_id)
    if attempts >= args.max_attempts and counts["readyCount"] < target_ready:
        warnings.append(f"已达到 max-attempts={args.max_attempts}，ready {counts['readyCount']}/{target_ready}")
    if no_more_candidates and counts["readyCount"] == 0:
        warnings.append("没有可用候选进入终审")

    if not args.skip_seo_geo_score and counts["readyCount"] > 0:
        score = runner.run_step("score:seo-geo", ["--status", "ready_for_review", "--strategy", args.strategy], engine_run_id)
        if score.result:
            seo_geo_scored = int(score.result.get("scored") or 0)
            if not score.ok:
                errors.append(f"score:seo-geo: {score.error or '部分失败'}")
        elif not score.ok:
            errors.append(f"score:seo-geo: {score.error}")
    elif args.skip_seo_geo_score:
        warnings.append("已跳过双评分")
    else:
        runner.run_step("score:seo-geo", engine_run_id=engine_run_id, skipped=True)

    if counts["readyCount"] > 0:
        channels = runner.run_step("channels:generate", ["--status", "ready_for_review", "--missing-only"], engine_run_id)
        if channels.result:
            counts["channelOutputsGenerated"] = int(channels.result.get("channelOutputsGenerated") or 0)
            if not channels.ok:
                errors.append(f"channels:generate: {channels.error or '部分失败'}")
        elif not channels.ok:
            errors.append(f"channels:generate: {channels.error}")
    else:
        runner.run_step("channels:generate", engine_run_id=engine_run_id, skipped=True)

    runner.run_step("db:list", ["--limit", "10"], engine_run_id)

    next_actions: list[str] = []
    if counts["factChecksCompleted"] > 0:
        next_actions.append("uv run contentflow db list --status needs_fact_sources 查看待补来源")
    if counts["qualityFailedCount"] > 0:
        next_actions.append("uv run contentflow score article-quality --status needs_quality_revision --force 查看/重评质量不足文章")
    if any("network connection error" in e or "LLM request failed" in e for e in errors):
        next_actions.append("LLM provider 不可达——检查代理后重跑")

    business_outcome = runtime.business_outcome(
        ready_count=counts["readyCount"],
        target_ready=target_ready,
        technical_failed=bool(errors) and counts["readyCount"] == 0 and not no_more_candidates,
    )
    status = "succeeded" if business_outcome == "target_met" and not errors else "partial" if counts["readyCount"] > 0 else "failed"
    if writer.failures.count > 0:
        warnings.append(f"⚠️ trace 写入失败 {writer.failures.count} 次: {'; '.join(writer.failures.samples[:2])}")
    writer.log_workflow_event(
        engine_run_id=engine_run_id,
        event_type="engine_completed",
        level="warning" if errors or status != "succeeded" else "info",
        message=f"engine {status}：ready {counts['readyCount']}/{target_ready} / 尝试 {counts['attemptedWritingTasks']} / 错误 {len(errors)}",
    )
    summary = {
        "ok": status == "succeeded",
        "engineRunId": engine_run_id,
        "runner": "python",
        "stepBackend": getattr(getattr(runner, "backend", None), "name", "custom"),
        "strategy": args.strategy,
        "targetReady": target_ready,
        "maxAttempts": args.max_attempts,
        "businessOutcome": business_outcome,
        "retryReusableWritingTasks": reusable_writing_tasks,
        **counts,
        "dedupeRejected": dedupe_rejected,
        "seoGeoScored": seo_geo_scored,
        "traceFailures": writer.failures.count,
        "warnings": warnings[:15],
        "errors": errors[:15],
        "nextActions": next_actions,
    }
    _finalize_engine_run(database, engine_run_id, {
        "status": status,
        "finished_at": db.now(),
        "topics_collected": counts["topicsCollected"],
        "topics_selected": counts["topicsSelected"],
        "articles_generated": counts["articlesGenerated"],
        "articles_validated": counts["readyCount"],
        "fact_checks_completed": counts["factChecksCompleted"],
        "channel_outputs_generated": counts["channelOutputsGenerated"],
        "summary_json": summary,
        "error_message": " | ".join(errors[:5])[:800] if errors else None,
    })
    return summary


def batch_args_from_daily(args: runtime.DailyArgs, *, run_id: str, is_active: int) -> runtime.BatchArgs:
    argv = [
        "--limit", "1",
        "--min-score", "80",
        "--target-ready", str(args.target_ready),
        "--max-attempts", str(args.max_attempts),
        "--run-type", "daily",
        "--run-id", run_id,
        "--daily-key", args.daily_key or run_control.get_daily_key(),
        "--run-scope", "daily",
        "--run-mode", args.mode,
        "--triggered-by", args.actor,
        "--trigger-source", args.trigger_source,
        "--is-active", str(is_active),
        *(["--as-of-date", args.daily_key or run_control.get_daily_key()] if args.engine_now else []),
        *(["--retry"] if args.mode == "retry" else []),
        *(args.extra or []),
    ]
    return runtime.parse_batch_args(argv)


def run_daily(args: runtime.DailyArgs, *, database: Any | None = None) -> dict[str, Any]:
    if args.engine_now:
        os.environ["ENGINE_NOW"] = args.engine_now
    if args.mode not in run_control.MODE_ACTION:
        return {"ok": False, "error": f"mode 非法: {args.mode}（允许: start/retry/rebuild/force）"}

    dry_run_id = db.make_run_id("engine")
    dry_is_active = 1 if args.mode != "force" or args.make_active else 0
    if args.dry_run:
        batch_args = batch_args_from_daily(args, run_id=dry_run_id, is_active=dry_is_active)
        return {
            "ok": True,
            "dryRun": True,
            "dailyKey": args.daily_key,
            "mode": args.mode,
            "engineNow": args.engine_now,
            "targetReady": args.target_ready,
            "maxAttempts": args.max_attempts,
            "batchArgv": runtime.build_batch_dry_run_plan(batch_args)["steps"],
            "message": "dry-run：未评估 run_control，未写 run_actions，未执行 batch",
        }

    database = database or db.Database()
    decision = run_control.can_start_daily(daily_key=args.daily_key, mode=args.mode, db_client=database)
    if args.plan_only:
        run_control.record_run_action(
            daily_key=args.daily_key,
            action=run_control.MODE_ACTION[args.mode],
            actor=args.actor,
            trigger_source=args.trigger_source,
            request={"mode": args.mode, "planOnly": True, "asOfDate": args.as_of_date, "targetReady": args.target_ready, "maxAttempts": args.max_attempts},
            result={"allowed": decision["allowed"], "reason": decision["reason"]},
            status="accepted" if decision["allowed"] else "rejected",
            error_message=None if decision["allowed"] else decision["reason"],
            db_client=database,
        )
        return {
            "ok": True,
            "planOnly": True,
            "dailyKey": args.daily_key,
            "mode": args.mode,
            "allowed": decision["allowed"],
            "reason": decision["reason"],
            "activeRun": {"id": decision["activeRun"]["id"], "status": decision["activeRun"]["status"]} if decision.get("activeRun") else None,
            "availableActions": decision["availableActions"],
        }

    if not decision["allowed"]:
        run_control.record_run_action(
            daily_key=args.daily_key,
            action=run_control.MODE_ACTION[args.mode],
            actor=args.actor,
            trigger_source=args.trigger_source,
            request={"mode": args.mode},
            status="rejected",
            error_message=decision["reason"],
            engine_run_id=(decision.get("activeRun") or {}).get("id"),
            db_client=database,
        )
        return {"ok": False, "rejected": True, "dailyKey": args.daily_key, "mode": args.mode, "reason": decision["reason"], "availableActions": decision["availableActions"]}

    new_run_id = db.make_run_id("engine")
    action_id = run_control.record_run_action(
        engine_run_id=new_run_id,
        daily_key=args.daily_key,
        action=run_control.MODE_ACTION[args.mode],
        actor=args.actor,
        trigger_source=args.trigger_source,
        request={"mode": args.mode, "extra": args.extra, "asOfDate": args.as_of_date, "targetReady": args.target_ready, "maxAttempts": args.max_attempts},
        status="running",
        db_client=database,
    )
    old = decision.get("activeRun")
    archive_warnings: list[str] = []
    if old and args.mode == "rebuild":
        run_control.mark_run_superseded(old_run_id=old["id"], new_run_id=new_run_id, reason="rebuild", db_client=database, trace_writer=trace.TraceWriter(db_client=database))
        archived = run_control.archive_run_data(engine_run_id=old["id"], superseded_by=new_run_id, db_client=database)
        archive_warnings.extend(archived["warnings"])
    elif old and args.mode == "retry":
        database.update("engine_runs", {"is_active": 0, "status": "superseded", "superseded_by": new_run_id, "finished_at": db.now()}, "id = %s", [old["id"]])

    is_active = 1 if args.mode != "force" or args.make_active else 0
    if old and args.mode == "force" and args.make_active:
        database.update("engine_runs", {"is_active": 0, "status": "superseded", "superseded_by": new_run_id, "finished_at": db.now()}, "id = %s", [old["id"]])

    summary = run_batch(batch_args_from_daily(args, run_id=new_run_id, is_active=is_active), database=database)
    status = "success" if summary.get("ok") else "failed"
    database.update("run_actions", {
        "status": status,
        "result_json": {"engineRunId": new_run_id, "engineStatus": "succeeded" if summary.get("ok") else "failed", "archiveWarnings": archive_warnings},
    }, "id = %s", [action_id])
    return summary
