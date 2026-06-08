from __future__ import annotations

import typer

from contentflow.commands.common import print_json
from contentflow.flow import graph, runtime

app = typer.Typer(add_completion=False, no_args_is_help=True)


@app.command("plan")
def graph_plan(
    limit: int = typer.Option(1, "--limit", min=1, max=200),
    target_ready: int = typer.Option(1, "--target-ready", min=1, max=50),
    max_attempts: int = typer.Option(runtime.DEFAULT_MAX_ATTEMPTS, "--max-attempts", min=1, max=200),
    min_score: int = typer.Option(80, "--min-score", min=0, max=100),
    strategy: str = typer.Option("balanced", "--strategy"),
    skip_seo_geo_score: bool = typer.Option(False, "--skip-seo-geo-score"),
) -> None:
    print_json({
        "ok": True,
        "runner": "python",
        "plan": graph.build_graph_dry_run_plan(
            limit=limit,
            target_ready=target_ready,
            max_attempts=max_attempts,
            min_score=min_score,
            strategy=strategy,
            skip_seo_geo_score=skip_seo_geo_score,
        ),
    })


@app.command("studio")
def graph_studio() -> None:
    print_json({
        "ok": False,
        "runner": "python",
        "error": "本 CLI 不启动独立 LangGraph Studio 服务；可使用 graph plan 查看主链路，或在 Python 中导入 contentflow.flow.graph.build_graph()。",
    }, exit_code=1)

