from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from typing import Any

from contentflow.flow.step_catalog import step_display_name, step_key_from_name

DEFAULT_TARGET_READY = 5
DEFAULT_MAX_ATTEMPTS = 15
STRATEGIES = {"balanced", "seo_first", "geo_first"}
BUSINESS_TZ = ZoneInfo("Asia/Shanghai")


def positive_int(value: Any, fallback: int, *, min_value: int = 1, max_value: int = 999) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return fallback
    if n < min_value:
        return fallback
    return min(n, max_value)


def assert_date_key(value: str | None, label: str = "date") -> str:
    raw = str(value or "")
    if len(raw) != 10:
        raise ValueError(f"{label} 必须是 YYYY-MM-DD")
    try:
        datetime.strptime(raw, "%Y-%m-%d")
    except ValueError as exc:
        raise ValueError(f"{label} 必须是 YYYY-MM-DD") from exc
    return raw


def normalize_engine_now(value: str | None) -> str | None:
    if not value:
        return None
    raw = str(value).strip()
    if len(raw) == 10 and raw[4] == "-" and raw[7] == "-":
        assert_date_key(raw, "ENGINE_NOW/--as-of-date")
        dt = datetime.strptime(raw, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    else:
        iso_like = raw if "T" in raw else raw.replace(" ", "T")
        if iso_like.endswith("Z"):
            iso_like = iso_like[:-1] + "+00:00"
        try:
            dt = datetime.fromisoformat(iso_like)
        except ValueError as exc:
            raise ValueError(f"ENGINE_NOW/--as-of-date 非法: {value}") from exc
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        else:
            dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def engine_now_date(value: str | None = None) -> datetime:
    normalized = normalize_engine_now(value)
    if normalized:
        return datetime.strptime(normalized, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc)


def mysql_datetime_from_date(date: datetime) -> str:
    utc = date.astimezone(timezone.utc) if date.tzinfo else date.replace(tzinfo=timezone.utc)
    return utc.strftime("%Y-%m-%d %H:%M:%S.") + f"{utc.microsecond // 1000:03d}"


def mysql_datetime(value: str | None = None) -> str:
    return mysql_datetime_from_date(engine_now_date(value))


def daily_key_from_date(date: datetime) -> str:
    utc = date.astimezone(timezone.utc) if date.tzinfo else date.replace(tzinfo=timezone.utc)
    return utc.astimezone(BUSINESS_TZ).strftime("%Y-%m-%d")


def business_datetime_from_date(date: datetime) -> datetime:
    utc = date.astimezone(timezone.utc) if date.tzinfo else date.replace(tzinfo=timezone.utc)
    return utc.astimezone(BUSINESS_TZ)


@dataclass(slots=True)
class BatchArgs:
    limit: int = 1
    min_score: int = 80
    run_type: str = "batch"
    force: bool = False
    strategy: str = "balanced"
    skip_seo_geo_score: bool = False
    dry_run: bool = False
    run_id: str | None = None
    daily_key: str | None = None
    run_scope: str = "batch"
    run_mode: str = "start"
    triggered_by: str = "cli"
    trigger_source: str = "cli"
    is_active: int = 1
    retry: bool = False
    target_ready: int | None = None
    max_attempts: int = DEFAULT_MAX_ATTEMPTS
    as_of_date: str | None = None
    engine_now: str | None = None


@dataclass(slots=True)
class DailyArgs:
    mode: str = "start"
    daily_key: str | None = None
    actor: str = "cli"
    trigger_source: str = "cli"
    plan_only: bool = False
    dry_run: bool = False
    make_active: bool = False
    extra: list[str] | None = None
    as_of_date: str | None = None
    engine_now: str | None = None
    target_ready: int = DEFAULT_TARGET_READY
    max_attempts: int = DEFAULT_MAX_ATTEMPTS


def _value(argv: list[str], index: int, flag: str) -> tuple[str, int]:
    if index + 1 >= len(argv):
        raise ValueError(f"{flag} 缺少参数")
    return argv[index + 1], index + 1


def parse_batch_args(argv: list[str]) -> BatchArgs:
    args = BatchArgs()
    i = 0
    while i < len(argv):
        flag = argv[i]
        if flag == "--limit":
            v, i = _value(argv, i, flag)
            args.limit = positive_int(v, 1, min_value=1, max_value=200)
        elif flag == "--min-score":
            v, i = _value(argv, i, flag)
            args.min_score = positive_int(v, 80, min_value=0, max_value=100)
        elif flag == "--run-type":
            args.run_type, i = _value(argv, i, flag)
        elif flag == "--force":
            args.force = True
        elif flag == "--strategy":
            args.strategy, i = _value(argv, i, flag)
        elif flag == "--skip-seo-geo-score":
            args.skip_seo_geo_score = True
        elif flag == "--dry-run":
            args.dry_run = True
        elif flag == "--run-id":
            args.run_id, i = _value(argv, i, flag)
        elif flag == "--daily-key":
            v, i = _value(argv, i, flag)
            args.daily_key = assert_date_key(v, "--daily-key")
        elif flag == "--run-scope":
            args.run_scope, i = _value(argv, i, flag)
        elif flag == "--run-mode":
            args.run_mode, i = _value(argv, i, flag)
        elif flag == "--triggered-by":
            args.triggered_by, i = _value(argv, i, flag)
        elif flag == "--trigger-source":
            args.trigger_source, i = _value(argv, i, flag)
        elif flag == "--is-active":
            v, i = _value(argv, i, flag)
            args.is_active = positive_int(v, 1, min_value=0, max_value=1)
        elif flag == "--retry":
            args.retry = True
        elif flag == "--target-ready":
            v, i = _value(argv, i, flag)
            args.target_ready = positive_int(v, DEFAULT_TARGET_READY, min_value=1, max_value=50)
        elif flag == "--max-attempts":
            v, i = _value(argv, i, flag)
            args.max_attempts = positive_int(v, DEFAULT_MAX_ATTEMPTS, min_value=1, max_value=200)
        elif flag == "--as-of-date":
            v, i = _value(argv, i, flag)
            args.as_of_date = assert_date_key(v, "--as-of-date")
            args.engine_now = normalize_engine_now(args.as_of_date)
            if not args.daily_key:
                args.daily_key = args.as_of_date
        i += 1

    if args.strategy not in STRATEGIES:
        raise ValueError(f"strategy 非法: {args.strategy}")
    if args.as_of_date and args.daily_key and args.daily_key != args.as_of_date:
        raise ValueError(f"--daily-key ({args.daily_key}) 必须与 --as-of-date ({args.as_of_date}) 一致")
    return args


def parse_daily_args(argv: list[str], *, default_daily_key: str | None = None) -> DailyArgs:
    args = DailyArgs(daily_key=default_daily_key or daily_key_from_date(datetime.now(timezone.utc)), extra=[])
    daily_key_explicit = False
    i = 0
    while i < len(argv):
        flag = argv[i]
        if flag == "--mode":
            args.mode, i = _value(argv, i, flag)
        elif flag == "--daily-key":
            v, i = _value(argv, i, flag)
            args.daily_key = assert_date_key(v, "--daily-key")
            daily_key_explicit = True
        elif flag == "--actor":
            args.actor, i = _value(argv, i, flag)
        elif flag == "--trigger-source":
            args.trigger_source, i = _value(argv, i, flag)
        elif flag == "--plan-only":
            args.plan_only = True
        elif flag == "--dry-run":
            args.dry_run = True
        elif flag == "--make-active":
            args.make_active = True
        elif flag == "--as-of-date":
            v, i = _value(argv, i, flag)
            args.as_of_date = assert_date_key(v, "--as-of-date")
        elif flag == "--target-ready":
            v, i = _value(argv, i, flag)
            args.target_ready = positive_int(v, DEFAULT_TARGET_READY, min_value=1, max_value=50)
        elif flag == "--max-attempts":
            v, i = _value(argv, i, flag)
            args.max_attempts = positive_int(v, DEFAULT_MAX_ATTEMPTS, min_value=1, max_value=200)
        else:
            args.extra.append(flag)
        i += 1
    if args.as_of_date:
        args.engine_now = normalize_engine_now(args.as_of_date)
        if not daily_key_explicit:
            args.daily_key = args.as_of_date
        if args.daily_key != args.as_of_date:
            raise ValueError(f"--daily-key ({args.daily_key}) 必须与 --as-of-date ({args.as_of_date}) 一致")
    return args


def resolved_target_ready(args: BatchArgs) -> int:
    return args.target_ready or args.limit


def build_batch_dry_run_plan(args: BatchArgs, *, reusable_writing_tasks: int | None = None) -> dict[str, Any]:
    target_ready = resolved_target_ready(args)
    retry_reusable_writing_tasks = reusable_writing_tasks if args.retry else None
    steps: list[dict[str, Any]] = []

    def command_step(command: str, *, args_text: str | None = None) -> dict[str, Any]:
        step: dict[str, Any] = {
            "stepKey": step_key_from_name(command),
            "displayName": step_display_name(command),
            "command": command,
        }
        if args_text:
            step["args"] = args_text
        return step

    if args.retry:
        steps.append({"stepKey": "retry_reusable_writing_tasks", "displayName": "重试任务接管", "command": "retry:check-reusable-writing-tasks"})
    if not (args.retry and reusable_writing_tasks and reusable_writing_tasks > 0):
        steps.extend([
            command_step("sources:collect"),
            command_step("topics:generate"),
            {"stepKey": "quota_loop", "displayName": "补位循环", "targetReady": target_ready, "maxAttempts": args.max_attempts},
            command_step("topics:select", args_text=f"--limit {args.limit} --strategy {args.strategy}"),
        ])
    steps.extend([
        command_step("articles:generate"),
        command_step("articles:factcheck"),
    ])
    if not args.skip_seo_geo_score:
        steps.append(command_step("score:seo-geo", args_text="--status ready_for_review"))
    steps.extend([
        command_step("channels:generate", args_text="--status ready_for_review --missing-only"),
        command_step("db:list"),
    ])
    return {
        "limit": args.limit,
        "targetReady": target_ready,
        "maxAttempts": args.max_attempts,
        "minScore": args.min_score,
        "strategy": args.strategy,
        "retry": args.retry,
        "retryReusableWritingTasks": retry_reusable_writing_tasks,
        "engineNow": args.engine_now,
        "steps": steps,
    }


def business_outcome(*, ready_count: int, target_ready: int, technical_failed: bool = False) -> str:
    if technical_failed:
        return "technical_failed"
    if ready_count >= target_ready:
        return "target_met"
    if ready_count > 0:
        return "partial"
    return "no_ready_articles"


def decide_ready_gate(*, intended_status: str, score: int | float | None, score_ok: bool = True, min_score: int = 80) -> dict[str, Any]:
    if intended_status != "ready_for_review":
        return {"status": intended_status, "gated": False, "score": score}
    if not score_ok or score is None:
        return {"status": "needs_quality_revision", "gated": True, "score": None, "reason": "文章质量主评分失败，不能进入终审"}
    if score < min_score:
        return {"status": "needs_quality_revision", "gated": True, "score": score, "reason": f"文章质量主评分 {score} < {min_score}（SEO/GEO 不能覆盖质量不足）"}
    return {"status": intended_status, "gated": False, "score": score}
