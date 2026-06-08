from __future__ import annotations

import typer

from contentflow.commands.common import handle_error, print_json
from contentflow.ops import maintenance

tools_app = typer.Typer(add_completion=False, no_args_is_help=True)
canonical_app = typer.Typer(add_completion=False, no_args_is_help=True)
keywords_app = typer.Typer(add_completion=False, no_args_is_help=True)
config_app = typer.Typer(add_completion=False, no_args_is_help=True)

tools_app.add_typer(canonical_app, name="canonical")


@tools_app.command("config-sync")
def tools_config_sync(
    force: bool = typer.Option(False, "--force"),
) -> None:
    try:
        result = maintenance.config_sync(force=force)
        print_json(result, exit_code=0 if result.get("ok") else 1)
    except Exception as exc:
        handle_error(exc)


@tools_app.command("keywords-analyze")
def tools_keywords_analyze() -> None:
    try:
        print_json(maintenance.keywords_analyze())
    except Exception as exc:
        handle_error(exc)


@keywords_app.command("analyze")
def keywords_analyze(
    as_json: bool = typer.Option(False, "--json"),
) -> None:
    _ = as_json
    tools_keywords_analyze()


@config_app.command("sync")
def config_sync(
    force: bool = typer.Option(False, "--force"),
) -> None:
    tools_config_sync(force=force)


@canonical_app.command("backfill")
def tools_canonical_backfill(
    limit: int | None = typer.Option(None, "--limit", min=1, max=10000),
) -> None:
    try:
        result = maintenance.backfill_canonical_sources(limit=limit)
        print_json(result, exit_code=0 if result.get("ok") else 1)
    except Exception as exc:
        handle_error(exc)

