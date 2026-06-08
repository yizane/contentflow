from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from contentflow.core import db, trace
from contentflow.flow.step_catalog import step_display_name, step_key_from_name


def arg_value(args: list[str], flag: str, default: Any = None) -> Any:
    try:
        index = args.index(flag)
    except ValueError:
        return default
    return args[index + 1] if index + 1 < len(args) else default


@dataclass(slots=True)
class StepOutcome:
    name: str
    ok: bool
    result: dict[str, Any] | None = None
    skipped: bool = False
    error: str | None = None
    stdout: str | None = None
    stderr: str | None = None


class StepBackend(Protocol):
    def run(self, *, name: str, args: list[str], engine_run_id: str, workflow_step_id: str | None) -> StepOutcome:
        ...


class PythonStepBackend:
    name = "python"
    SUPPORTED_STEPS = {
        "sources:collect",
        "topics:generate",
        "topics:select",
        "articles:generate",
        "articles:factcheck",
        "score:seo-geo",
        "score:article-quality",
        "channels:generate",
        "sources:resolve",
        "sources:fix",
        "articles:revise",
        "content:classify",
        "package:export",
        "review:mark",
        "topic:audition",
        "engine:report",
        "db:list",
        "db:show",
    }

    def __init__(self, *, enabled_steps: set[str] | None = None, database: Any | None = None):
        self.enabled_steps = set(self.SUPPORTED_STEPS) if enabled_steps is None else enabled_steps
        self.database = database

    def run(self, *, name: str, args: list[str], engine_run_id: str, workflow_step_id: str | None) -> StepOutcome:
        if name in self.enabled_steps:
            if name == "sources:collect":
                from contentflow.domains.sources.collect import collect_sources

                result = collect_sources(engine_run_id=engine_run_id, database=self.database)
                result.pop("perSource", None)
                return StepOutcome(name=name, ok=bool(result.get("ok", True)), result=result)
            if name == "topics:generate":
                from contentflow.domains.topics.generation import generate_topics

                result = generate_topics(engine_run_id=engine_run_id, database=self.database)
                return StepOutcome(name=name, ok=bool(result.get("ok", True)), result=result)
            if name == "topics:select":
                from contentflow.domains.topics.selection import select_topics_for_writing

                result = select_topics_for_writing(
                    limit=int(arg_value(args, "--limit", 1)),
                    min_score=int(arg_value(args, "--min-score", 80)),
                    category=arg_value(args, "--category", None),
                    strategy=str(arg_value(args, "--strategy", "balanced")),
                    dry_run="--dry-run" in args,
                    engine_run_id=engine_run_id,
                    database=self.database,
                )
                return StepOutcome(name=name, ok=bool(result.get("ok", True)), result=result)
            if name == "articles:generate":
                from contentflow.domains.production.article_generation import generate_articles_from_writing_tasks

                result = generate_articles_from_writing_tasks(
                    limit=int(arg_value(args, "--limit", 1)),
                    include_failed="--include-failed" in args,
                    engine_run_id=engine_run_id,
                    database=self.database,
                )
                return StepOutcome(name=name, ok=bool(result.get("ok", True)), result=result)
            if name == "articles:factcheck":
                from contentflow.domains.production.factcheck import factcheck_articles_for_review_gate

                result = factcheck_articles_for_review_gate(
                    limit=int(arg_value(args, "--limit", 20)),
                    article_id=arg_value(args, "--article-id", None),
                    engine_run_id=engine_run_id,
                    database=self.database,
                )
                return StepOutcome(name=name, ok=bool(result.get("ok", True)), result=result)
            if name == "score:seo-geo":
                from contentflow.domains.production.scoring import run_scores

                result = run_scores(
                    article_id=arg_value(args, "--article-id", None),
                    slug=arg_value(args, "--slug", None),
                    status=arg_value(args, "--status", None),
                    strategy=str(arg_value(args, "--strategy", "balanced")),
                    limit=int(arg_value(args, "--limit", 10)),
                    force="--force" in args,
                    engine_run_id=engine_run_id,
                    database=self.database,
                )
                return StepOutcome(name=name, ok=bool(result.get("ok", True)), result=result)
            if name == "channels:generate":
                from contentflow.domains.production.channels import run_channels

                result = run_channels(
                    article_id=arg_value(args, "--article-id", None),
                    slug=arg_value(args, "--slug", None),
                    status=arg_value(args, "--status", None),
                    missing_only="--missing-only" in args,
                    force="--force" in args,
                    limit=int(arg_value(args, "--limit", 20)),
                    engine_run_id=engine_run_id,
                    database=self.database,
                )
                return StepOutcome(name=name, ok=bool(result.get("ok", True)), result=result)
            if name == "score:article-quality":
                from contentflow.domains.production.article_quality import run_article_quality

                result = run_article_quality(
                    status=arg_value(args, "--status", None),
                    article_id=arg_value(args, "--article-id", None),
                    all_articles="--all" in args,
                    limit=int(arg_value(args, "--limit", 10)),
                    force="--force" in args,
                    engine_run_id=engine_run_id,
                    database=self.database,
                )
                return StepOutcome(name=name, ok=bool(result.get("ok", True)), result=result)
            if name == "sources:resolve":
                from contentflow.domains.production.source_resolution import run_source_resolution

                result = run_source_resolution(
                    article_id=arg_value(args, "--article-id", None),
                    limit=int(arg_value(args, "--limit", 1)),
                    engine_run_id=engine_run_id,
                    database=self.database,
                )
                return StepOutcome(name=name, ok=bool(result.get("ok", True)), result=result)
            if name == "sources:fix":
                from contentflow.domains.production.source_resolution import run_sources_fix

                result = run_sources_fix(
                    article_id=arg_value(args, "--article-id", None),
                    slug=arg_value(args, "--slug", None),
                    limit=int(arg_value(args, "--limit", 1)),
                    force="--force" in args,
                    engine_run_id=engine_run_id,
                    database=self.database,
                )
                return StepOutcome(name=name, ok=bool(result.get("ok", True)), result=result)
            if name == "articles:revise":
                from contentflow.domains.production.source_resolution import run_revision

                result = run_revision(
                    article_id=arg_value(args, "--article-id", None),
                    engine_run_id=engine_run_id,
                    database=self.database,
                )
                return StepOutcome(name=name, ok=bool(result.get("ok", True)), result=result)
            if name == "content:classify":
                from contentflow.domains.taxonomy.classification import run_classify

                result = run_classify(
                    entity=arg_value(args, "--entity", None),
                    all_entities="--all" in args,
                    limit=int(arg_value(args, "--limit", 100)),
                    force="--force" in args,
                    no_ai="--no-ai" in args,
                    ai_batch=int(arg_value(args, "--ai-batch", 15)),
                    max_ai_calls=int(arg_value(args, "--max-ai-calls", 0)) or None,
                    engine_run_id=engine_run_id,
                    database=self.database,
                )
                return StepOutcome(name=name, ok=bool(result.get("ok", True)), result=result)
            if name == "package:export":
                from contentflow.domains.production.packages import run_package_export

                result = run_package_export(
                    article_id=arg_value(args, "--article-id", None),
                    slug=arg_value(args, "--slug", None),
                    status=arg_value(args, "--status", None),
                    limit=int(arg_value(args, "--limit", 10)),
                    require_channels="--require-channels" in args,
                    with_channels="--with-channels" in args,
                    engine_run_id=engine_run_id,
                    database=self.database,
                )
                return StepOutcome(name=name, ok=bool(result.get("ok", True)), result=result)
            if name == "review:mark":
                from contentflow.domains.production.review import mark_review

                result = mark_review(
                    article_id=arg_value(args, "--article-id", None),
                    slug=arg_value(args, "--slug", None),
                    status=str(arg_value(args, "--status", "")),
                    note=arg_value(args, "--note", None),
                    dry_run="--dry-run" in args,
                    actor=str(arg_value(args, "--actor", "cli")),
                    database=self.database,
                )
                return StepOutcome(name=name, ok=bool(result.get("ok", True)), result=result)
            if name == "topic:audition":
                from contentflow.domains.topics.audition import run_topic_audition

                result = run_topic_audition(
                    rounds=int(arg_value(args, "--rounds", 10)),
                    limit=int(arg_value(args, "--limit", 1)),
                    min_score=int(arg_value(args, "--min-score", 80)),
                    refresh_candidates="--refresh-candidates" in args,
                    engine_run_id=engine_run_id,
                    database=self.database,
                )
                return StepOutcome(name=name, ok=bool(result.get("ok", True)), result=result)
            if name == "engine:report":
                from contentflow.ops.report import build_engine_report

                result = build_engine_report(
                    run_id=arg_value(args, "--run-id", None),
                    since=arg_value(args, "--since", None),
                    database=self.database,
                )
                return StepOutcome(name=name, ok=bool(result.get("ok", True)), result=result)
            if name == "db:list":
                limit = int(arg_value(args, "--limit", 10))
                rows = (self.database or db.Database()).query(
                    f"SELECT id, title, status, article_quality_score, seo_score, geo_score, created_at FROM articles ORDER BY created_at DESC LIMIT {max(1, min(200, limit))}"
                )
                return StepOutcome(name=name, ok=True, result={"ok": True, "items": rows, "count": len(rows)})
            if name == "db:show":
                from contentflow.ops.maintenance import show_article

                result = show_article(
                    article_id=arg_value(args, "--id", arg_value(args, "--article-id", None)),
                    slug=arg_value(args, "--slug", None),
                    status=arg_value(args, "--status", None),
                    include_content="--include-content" in args,
                    database=self.database,
                )
                return StepOutcome(name=name, ok=bool(result.get("ok", True)), result=result)
            return StepOutcome(name=name, ok=False, error=f"Python step 尚未实现: {name}")
            return StepOutcome(name=name, ok=False, error=f"Python step 未启用: {name}")


def summarize_step_output(result: dict[str, Any], *, round_no: int) -> dict[str, Any]:
    summary: dict[str, Any] = {"round": round_no}
    count_fields = {
        "selected": "selectedCount",
        "deferred": "deferredCount",
        "batchSkipped": "batchSkippedCount",
        "writingTasks": "writingTaskCount",
        "results": "resultsCount",
        "items": "itemsCount",
    }
    skip_fields = set(count_fields)
    for key, value in result.items():
        if value is None or value == [] or value == {}:
            continue
        if key in skip_fields:
            if key == "writingTasks" and "writingTaskCount" in summary:
                continue
            if isinstance(value, list):
                summary[count_fields[key]] = len(value)
            continue
        summary[key] = value
    return summary


class StepRunner:
    def __init__(self, *, trace_writer: trace.TraceWriter, backend: StepBackend | None = None):
        self.trace = trace_writer
        self.backend = backend or PythonStepBackend()
        self.step_order = 0
        self.step_rounds: dict[str, int] = {}

    def run_step(self, name: str, args: list[str] | None = None, engine_run_id: str | None = None, *, skipped: bool = False) -> StepOutcome:
        args = args or []
        self.step_order += 1
        round_no = self.step_rounds.get(name, 0) + 1
        self.step_rounds[name] = round_no
        step_id = self.trace.create_workflow_step(
            engine_run_id=engine_run_id,
            step_key=step_key_from_name(name),
            step_name=step_display_name(name),
            step_order=self.step_order,
            input_summary={"args": args, "round": round_no, "command": name},
        )
        if skipped:
            self.trace.finish_workflow_step(step_id, status="skipped")
            return StepOutcome(name=name, ok=True, skipped=True)

        self.trace.start_workflow_step(step_id)
        self.trace.log_workflow_event(
            engine_run_id=engine_run_id,
            workflow_step_id=step_id,
            event_type="step_started",
            level="info",
            message=f"步骤开始: {step_display_name(name)}",
        )

        try:
            outcome = self.backend.run(
                name=name,
                args=args,
                engine_run_id=engine_run_id or "",
                workflow_step_id=step_id,
            )
        except Exception as exc:
            outcome = StepOutcome(name=name, ok=False, error=str(exc)[:300])

        warnings = outcome.result.get("warnings") if isinstance(outcome.result, dict) else None
        has_warnings = isinstance(warnings, list) and bool(warnings)
        self.trace.finish_workflow_step(
            step_id,
            status="success" if outcome.ok and not has_warnings else "warning" if outcome.ok else "failed",
            output_summary=summarize_step_output(outcome.result, round_no=round_no) if isinstance(outcome.result, dict) else None,
            warnings=warnings[:10] if has_warnings else None,
            error_message=None if outcome.ok else outcome.error,
        )
        self.trace.log_workflow_event(
            engine_run_id=engine_run_id,
            workflow_step_id=step_id,
            event_type="step_completed",
            level="info" if outcome.ok else "error",
            message=f"步骤{'完成' if outcome.ok else '失败'}: {step_display_name(name)}{'' if outcome.ok else f' - {outcome.error}'}",
        )
        return outcome
