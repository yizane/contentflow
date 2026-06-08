from __future__ import annotations

import typer

from contentflow.commands.common import handle_error, print_json
from contentflow.domains.production import article_generation, article_quality, channels, factcheck, packages, review, scoring, source_resolution
from contentflow.domains.taxonomy import classification

articles_app = typer.Typer(add_completion=False, no_args_is_help=True)
score_app = typer.Typer(add_completion=False, no_args_is_help=True)
channels_app = typer.Typer(add_completion=False, no_args_is_help=True)
content_app = typer.Typer(add_completion=False, no_args_is_help=True)
package_app = typer.Typer(add_completion=False, no_args_is_help=True)
review_app = typer.Typer(add_completion=False, no_args_is_help=True)


@articles_app.command("generate", help="处理写作任务，生成文章初稿、版本和初始质量结果。")
def articles_generate(
    limit: int = typer.Option(1, "--limit", min=1, max=50),
    include_failed: bool = typer.Option(False, "--include-failed"),
    engine_run_id: str | None = typer.Option(None, "--engine-run-id"),
) -> None:
    try:
        result = article_generation.generate_articles_from_writing_tasks(limit=limit, include_failed=include_failed, engine_run_id=engine_run_id)
        print_json(result, exit_code=0 if result.get("ok") else 1)
    except Exception as exc:
        handle_error(exc)


@articles_app.command("factcheck", help="对已生成文章做事实核查和来源门禁，决定是否进入终审。")
def articles_factcheck(
    limit: int = typer.Option(20, "--limit", min=1, max=50),
    article_id: str | None = typer.Option(None, "--article-id"),
    engine_run_id: str | None = typer.Option(None, "--engine-run-id"),
) -> None:
    try:
        result = factcheck.factcheck_articles_for_review_gate(limit=limit, article_id=article_id, engine_run_id=engine_run_id)
        print_json(result, exit_code=0 if result.get("ok") else 1)
    except Exception as exc:
        handle_error(exc)


@articles_app.command("revise")
def articles_revise(
    article_id: str | None = typer.Option(None, "--article-id"),
    engine_run_id: str | None = typer.Option(None, "--engine-run-id"),
) -> None:
    try:
        result = source_resolution.run_revision(article_id=article_id, engine_run_id=engine_run_id)
        print_json(result, exit_code=0 if result.get("ok") else 1)
    except Exception as exc:
        handle_error(exc)


@score_app.command("seo-geo")
def score_seo_geo(
    article_id: str | None = typer.Option(None, "--article-id"),
    slug: str | None = typer.Option(None, "--slug"),
    status: str | None = typer.Option(None, "--status"),
    strategy: str = typer.Option("balanced", "--strategy"),
    limit: int = typer.Option(10, "--limit", min=1, max=100),
    force: bool = typer.Option(False, "--force"),
    engine_run_id: str | None = typer.Option(None, "--engine-run-id"),
) -> None:
    try:
        result = scoring.run_scores(article_id=article_id, slug=slug, status=status, strategy=strategy, limit=limit, force=force, engine_run_id=engine_run_id)
        print_json(result, exit_code=0 if result.get("ok") else 1)
    except Exception as exc:
        handle_error(exc)


@score_app.command("article-quality")
def score_article_quality(
    status: str | None = typer.Option(None, "--status"),
    article_id: str | None = typer.Option(None, "--article-id"),
    all_articles: bool = typer.Option(False, "--all"),
    limit: int = typer.Option(10, "--limit", min=1, max=50),
    force: bool = typer.Option(False, "--force"),
    engine_run_id: str | None = typer.Option(None, "--engine-run-id"),
) -> None:
    try:
        result = article_quality.run_article_quality(status=status, article_id=article_id, all_articles=all_articles, limit=limit, force=force, engine_run_id=engine_run_id)
        print_json(result, exit_code=0 if result.get("ok") else 1)
    except Exception as exc:
        handle_error(exc)


@channels_app.command("generate")
def channels_generate(
    article_id: str | None = typer.Option(None, "--article-id"),
    slug: str | None = typer.Option(None, "--slug"),
    status: str | None = typer.Option(None, "--status"),
    missing_only: bool = typer.Option(False, "--missing-only"),
    force: bool = typer.Option(False, "--force"),
    limit: int = typer.Option(20, "--limit", min=1, max=100),
    engine_run_id: str | None = typer.Option(None, "--engine-run-id"),
) -> None:
    try:
        result = channels.run_channels(article_id=article_id, slug=slug, status=status, missing_only=missing_only, force=force, limit=limit, engine_run_id=engine_run_id)
        print_json(result, exit_code=0 if result.get("ok") else 1)
    except Exception as exc:
        handle_error(exc)


@content_app.command("classify")
def content_classify(
    entity: str | None = typer.Option(None, "--entity"),
    all_entities: bool = typer.Option(False, "--all"),
    limit: int = typer.Option(100, "--limit", min=1, max=2000),
    force: bool = typer.Option(False, "--force"),
    no_ai: bool = typer.Option(False, "--no-ai"),
    ai_batch: int = typer.Option(classification.DEFAULT_AI_BATCH, "--ai-batch", min=1, max=30),
    max_ai_calls: int | None = typer.Option(None, "--max-ai-calls"),
    engine_run_id: str | None = typer.Option(None, "--engine-run-id"),
) -> None:
    try:
        result = classification.run_classify(entity=entity, all_entities=all_entities, limit=limit, force=force, no_ai=no_ai, ai_batch=ai_batch, max_ai_calls=max_ai_calls, engine_run_id=engine_run_id)
        print_json(result, exit_code=0 if result.get("ok") else 1)
    except Exception as exc:
        handle_error(exc)


@package_app.command("export")
def package_export(
    article_id: str | None = typer.Option(None, "--article-id"),
    slug: str | None = typer.Option(None, "--slug"),
    status: str | None = typer.Option(None, "--status"),
    limit: int = typer.Option(10, "--limit", min=1, max=100),
    require_channels: bool = typer.Option(False, "--require-channels"),
    with_channels: bool = typer.Option(False, "--with-channels"),
    engine_run_id: str | None = typer.Option(None, "--engine-run-id"),
) -> None:
    try:
        result = packages.run_package_export(article_id=article_id, slug=slug, status=status, limit=limit, require_channels=require_channels, with_channels=with_channels, engine_run_id=engine_run_id)
        print_json(result, exit_code=0 if result.get("ok") else 1)
    except Exception as exc:
        handle_error(exc)


@review_app.command("mark")
def review_mark(
    status: str = typer.Option(..., "--status"),
    article_id: str | None = typer.Option(None, "--article-id"),
    slug: str | None = typer.Option(None, "--slug"),
    note: str | None = typer.Option(None, "--note"),
    dry_run: bool = typer.Option(False, "--dry-run"),
    actor: str = typer.Option("cli", "--actor"),
) -> None:
    try:
        result = review.mark_review(article_id=article_id, slug=slug, status=status, note=note, dry_run=dry_run, actor=actor)
        print_json(result, exit_code=0 if result.get("ok") else 1)
    except Exception as exc:
        handle_error(exc)
