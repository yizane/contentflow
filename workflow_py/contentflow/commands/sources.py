from __future__ import annotations

import typer

from contentflow.commands.common import handle_error, print_json
from contentflow.domains.production import source_resolution
from contentflow.domains.sources import collect as source_collect
from contentflow.ops import maintenance

app = typer.Typer(add_completion=False, no_args_is_help=True)


@app.command("collect")
def sources_collect(
    engine_run_id: str | None = typer.Option(None, "--engine-run-id"),
    daily_key: str | None = typer.Option(None, "--daily-key"),
) -> None:
    try:
        result = source_collect.collect_sources(engine_run_id=engine_run_id, daily_key=daily_key)
        print_json(result, exit_code=0 if result.get("ok") else 1)
    except Exception as exc:
        handle_error(exc)


@app.command("resolve")
def sources_resolve(
    article_id: str | None = typer.Option(None, "--article-id"),
    limit: int = typer.Option(1, "--limit", min=1, max=50),
    engine_run_id: str | None = typer.Option(None, "--engine-run-id"),
) -> None:
    try:
        result = source_resolution.run_source_resolution(article_id=article_id, limit=limit, engine_run_id=engine_run_id)
        print_json(result, exit_code=0 if result.get("ok") else 1)
    except Exception as exc:
        handle_error(exc)


@app.command("fix")
def sources_fix(
    article_id: str | None = typer.Option(None, "--article-id"),
    slug: str | None = typer.Option(None, "--slug"),
    limit: int = typer.Option(1, "--limit", min=1, max=50),
    force: bool = typer.Option(False, "--force"),
    engine_run_id: str | None = typer.Option(None, "--engine-run-id"),
) -> None:
    try:
        result = source_resolution.run_sources_fix(article_id=article_id, slug=slug, limit=limit, force=force, engine_run_id=engine_run_id)
        print_json(result, exit_code=0 if result.get("ok") else 1)
    except Exception as exc:
        handle_error(exc)


@app.command("backfill-canonical")
def sources_backfill_canonical(
    limit: int | None = typer.Option(None, "--limit", min=1, max=10000),
) -> None:
    try:
        result = maintenance.backfill_canonical_sources(limit=limit)
        print_json(result, exit_code=0 if result.get("ok") else 1)
    except Exception as exc:
        handle_error(exc)


@app.command("check")
def sources_check() -> None:
    try:
        result = maintenance.sources_check()
        print_json(result, exit_code=0 if result.get("ok") else 1)
    except Exception as exc:
        handle_error(exc)

