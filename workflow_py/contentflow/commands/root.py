from __future__ import annotations

import typer

from contentflow.commands import db, engine, env, graph, ops, production, sources, topics

app = typer.Typer(add_completion=False, no_args_is_help=True)

app.add_typer(db.app, name="db")
app.add_typer(engine.app, name="engine")
app.add_typer(env.app, name="env")
app.add_typer(graph.app, name="graph")
app.add_typer(sources.app, name="sources")
app.add_typer(topics.app, name="topics")
app.add_typer(topics.app, name="topic")
app.add_typer(production.articles_app, name="articles")
app.add_typer(production.score_app, name="score")
app.add_typer(production.channels_app, name="channels")
app.add_typer(production.content_app, name="content")
app.add_typer(production.package_app, name="package")
app.add_typer(production.review_app, name="review")
app.add_typer(ops.tools_app, name="tools")
app.add_typer(ops.keywords_app, name="keywords")
app.add_typer(ops.config_app, name="config")
