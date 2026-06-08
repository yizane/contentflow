from __future__ import annotations

from typing import Any

import typer

from contentflow.commands.common import handle_error, print_json
from contentflow.core import db
from contentflow.ops import maintenance

app = typer.Typer(add_completion=False, no_args_is_help=True)


@app.command("ping")
def db_ping() -> None:
    try:
        print_json(db.ping())
    except Exception as exc:
        handle_error(exc)


@app.command("init")
def db_init() -> None:
    try:
        print_json(db.init_schema())
    except Exception as exc:
        handle_error(exc)


@app.command("migrate")
def db_migrate() -> None:
    try:
        print_json(db.migrate())
    except Exception as exc:
        handle_error(exc)


@app.command("list")
def db_list(
    status: str | None = typer.Option(None, "--status"),
    content_type: str | None = typer.Option(None, "--content-type"),
    business_category: str | None = typer.Option(None, "--business-category"),
    topic_cluster: str | None = typer.Option(None, "--topic-cluster"),
    with_scores: bool = typer.Option(False, "--with-scores"),
    as_json: bool = typer.Option(False, "--json"),
    limit: int = typer.Option(10, "--limit", min=1, max=200),
) -> None:
    try:
        params: list[Any] = []
        clauses: list[str] = []
        if status:
            clauses.append("status = %s")
            params.append(status)
        if content_type:
            clauses.append("content_type = %s")
            params.append(content_type)
        if business_category:
            clauses.append("business_category = %s")
            params.append(business_category)
        if topic_cluster:
            clauses.append("topic_cluster = %s")
            params.append(topic_cluster)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        score_fields = ", article_quality_score, seo_score, geo_score" if with_scores else ""
        rows = db.query(
            f"SELECT id, title, status, content_type, business_category, topic_cluster{score_fields}, created_at FROM articles {where} ORDER BY created_at DESC LIMIT {limit}",
            params,
        )
        print_json({"ok": True, "items": rows, "count": len(rows), "json": as_json, "withScores": with_scores})
    except Exception as exc:
        handle_error(exc)


@app.command("show")
def db_show(
    article_id: str | None = typer.Option(None, "--id", "--article-id"),
    slug: str | None = typer.Option(None, "--slug"),
    status: str | None = typer.Option(None, "--status"),
    include_content: bool = typer.Option(False, "--include-content"),
) -> None:
    try:
        result = maintenance.show_article(article_id=article_id, slug=slug, status=status, include_content=include_content)
        print_json(result, exit_code=0 if result.get("ok") else 1)
    except Exception as exc:
        handle_error(exc)

