from __future__ import annotations

import typer

from contentflow.commands.common import handle_error, print_json
from contentflow.flow import daily, runtime
from contentflow.ops import report

app = typer.Typer(add_completion=False, no_args_is_help=True)


@app.command("batch", context_settings={"allow_extra_args": True, "ignore_unknown_options": True})
def engine_batch(
    ctx: typer.Context,
    limit: int = typer.Option(1, "--limit", min=1, max=200),
    min_score: int = typer.Option(80, "--min-score", min=0, max=100),
    target_ready: int | None = typer.Option(None, "--target-ready", min=1, max=50),
    max_attempts: int = typer.Option(runtime.DEFAULT_MAX_ATTEMPTS, "--max-attempts", min=1, max=200),
    strategy: str = typer.Option("balanced", "--strategy"),
    skip_seo_geo_score: bool = typer.Option(False, "--skip-seo-geo-score"),
    dry_run: bool = typer.Option(False, "--dry-run"),
) -> None:
    argv = [
        "--limit",
        str(limit),
        "--min-score",
        str(min_score),
        "--max-attempts",
        str(max_attempts),
        "--strategy",
        strategy,
        *("--skip-seo-geo-score".split() if skip_seo_geo_score else []),
        *("--dry-run".split() if dry_run else []),
        *(["--target-ready", str(target_ready)] if target_ready else []),
        *ctx.args,
    ]
    try:
        args = runtime.parse_batch_args(argv)
        result = daily.run_batch(args)
        print_json(result, exit_code=0 if result.get("ok") else 1)
    except Exception as exc:
        handle_error(exc)


@app.command("daily", context_settings={"allow_extra_args": True, "ignore_unknown_options": True})
def engine_daily(
    ctx: typer.Context,
    mode: str = typer.Option("start", "--mode"),
    daily_key: str | None = typer.Option(None, "--daily-key"),
    actor: str = typer.Option("cli", "--actor"),
    trigger_source: str = typer.Option("cli", "--trigger-source"),
    plan_only: bool = typer.Option(False, "--plan-only"),
    dry_run: bool = typer.Option(False, "--dry-run"),
    target_ready: int = typer.Option(runtime.DEFAULT_TARGET_READY, "--target-ready", min=1, max=50),
    max_attempts: int = typer.Option(runtime.DEFAULT_MAX_ATTEMPTS, "--max-attempts", min=1, max=200),
) -> None:
    argv = [
        "--mode",
        mode,
        "--actor",
        actor,
        "--trigger-source",
        trigger_source,
        "--target-ready",
        str(target_ready),
        "--max-attempts",
        str(max_attempts),
        *(["--daily-key", daily_key] if daily_key else []),
        *("--plan-only".split() if plan_only else []),
        *("--dry-run".split() if dry_run else []),
        *ctx.args,
    ]
    try:
        args = runtime.parse_daily_args(argv)
        result = daily.run_daily(args)
        print_json(result, exit_code=0 if result.get("ok") else 1)
    except Exception as exc:
        handle_error(exc)


@app.command("report")
def engine_report(
    run_id: str | None = typer.Option(None, "--run-id"),
    since: str | None = typer.Option(None, "--since"),
) -> None:
    try:
        result = report.build_engine_report(run_id=run_id, since=since)
        print_json(result, exit_code=0 if result.get("ok") else 1)
    except Exception as exc:
        handle_error(exc)

