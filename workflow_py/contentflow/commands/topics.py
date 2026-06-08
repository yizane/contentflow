from __future__ import annotations

import typer

from contentflow.commands.common import handle_error, print_json
from contentflow.domains.topics import audition
from contentflow.domains.topics import generation as topic_generation
from contentflow.domains.topics import selection as topic_selection

app = typer.Typer(add_completion=False, no_args_is_help=True)


@app.command("generate", help="基于采集素材建立候选主题池，不创建写作任务。")
def topics_generate(
    engine_run_id: str | None = typer.Option(None, "--engine-run-id"),
) -> None:
    try:
        result = topic_generation.generate_topics(engine_run_id=engine_run_id)
        print_json(result, exit_code=0 if result.get("ok") else 1)
    except Exception as exc:
        handle_error(exc)


@app.command("select", help="从候选主题池挑选本轮要写的主题，并写入写作任务队列。")
def topics_select(
    limit: int = typer.Option(1, "--limit", min=1, max=50),
    min_score: int = typer.Option(80, "--min-score", min=0, max=100),
    category: str | None = typer.Option(None, "--category"),
    strategy: str = typer.Option("balanced", "--strategy"),
    dry_run: bool = typer.Option(False, "--dry-run"),
    show_portfolio_debug: bool = typer.Option(False, "--show-portfolio-debug"),
    engine_run_id: str | None = typer.Option(None, "--engine-run-id"),
) -> None:
    try:
        result = topic_selection.select_topics_for_writing(limit=limit, min_score=min_score, category=category, strategy=strategy, dry_run=dry_run, engine_run_id=engine_run_id)
        result["showPortfolioDebug"] = show_portfolio_debug
        print_json(result, exit_code=0 if result.get("ok") else 1)
    except Exception as exc:
        handle_error(exc)


@app.command("audition")
def topics_audition(
    rounds: int = typer.Option(10, "--rounds", min=1, max=60),
    limit: int = typer.Option(1, "--limit", min=1, max=5),
    min_score: int = typer.Option(80, "--min-score", min=0, max=100),
    refresh_candidates: bool = typer.Option(False, "--refresh-candidates"),
    as_json: bool = typer.Option(False, "--json"),
    engine_run_id: str | None = typer.Option(None, "--engine-run-id"),
) -> None:
    try:
        result = audition.run_topic_audition(rounds=rounds, limit=limit, min_score=min_score, refresh_candidates=refresh_candidates, engine_run_id=engine_run_id)
        result["json"] = as_json
        print_json(result, exit_code=0 if result.get("ok") else 1)
    except Exception as exc:
        handle_error(exc)
