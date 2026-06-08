from __future__ import annotations

from typing import Any

from contentflow.core import db


def build_graph_dry_run_plan(*, limit: int, target_ready: int, max_attempts: int, min_score: int = 80, strategy: str = "balanced", skip_seo_geo_score: bool = False) -> list[dict[str, Any]]:
    plan: list[dict[str, Any]] = [
        {"name": "sources:collect", "stepKey": "sources_collect", "displayName": "资料采集"},
        {"name": "topics:generate", "stepKey": "topics_generate", "displayName": "候选主题生成"},
        {"name": "quota:loop", "stepKey": "quota_loop", "displayName": "补位循环", "targetReady": target_ready, "maxAttempts": max_attempts},
        {"name": "topics:select", "stepKey": "topics_select", "displayName": "选题入选与写作排队", "args": ["--limit", str(limit), "--min-score", str(min_score), "--strategy", strategy]},
        {"name": "articles:generate", "stepKey": "articles_generate", "displayName": "文章初稿生成"},
        {"name": "articles:factcheck", "stepKey": "articles_factcheck", "displayName": "事实核查与来源门禁"},
    ]
    if not skip_seo_geo_score:
        plan.append({"name": "score:seo-geo", "stepKey": "seo_geo_score", "displayName": "SEO/GEO 辅助评分"})
    plan.extend([
        {"name": "channels:generate", "stepKey": "channels_generate", "displayName": "渠道改写"},
        {"name": "db:list", "stepKey": "db_list", "displayName": "运行摘要"},
    ])
    return plan


def should_finish_quota_loop(state: dict[str, Any]) -> bool:
    ready_count = int(state.get("readyCount") or 0)
    target_ready = int(state.get("targetReady") or 1)
    attempts = int(state.get("attempts") or 0)
    max_attempts = int(state.get("maxAttempts") or 15)
    no_more = bool(state.get("noMoreCandidates"))
    return ready_count >= target_ready or no_more or attempts >= max_attempts


def _state_int(state: dict[str, Any], key: str, default: int) -> int:
    try:
        return int(state.get(key) or default)
    except (TypeError, ValueError):
        return default


def _database(state: dict[str, Any], explicit: Any | None) -> Any:
    return explicit or state.get("database") or db.Database()


def build_graph(*, database: Any | None = None):
    try:
        from langgraph.graph import END, START, StateGraph
    except Exception as exc:  # pragma: no cover - import depends on optional package internals
        raise RuntimeError(f"Python LangGraph 不可用: {exc}") from exc

    def collect_sources_node(state: dict[str, Any]) -> dict[str, Any]:
        from contentflow.domains.sources.collect import collect_sources

        result = collect_sources(engine_run_id=state.get("engineRunId"), database=_database(state, database))
        result.pop("perSource", None)
        return {**state, "sourcesCollect": result}

    def generate_topics_node(state: dict[str, Any]) -> dict[str, Any]:
        from contentflow.domains.topics.generation import generate_topics

        result = generate_topics(engine_run_id=state.get("engineRunId"), database=_database(state, database))
        return {**state, "topicsGenerate": result}

    def select_topics_node(state: dict[str, Any]) -> dict[str, Any]:
        from contentflow.domains.topics.selection import select_topics_for_writing

        result = select_topics_for_writing(
            limit=_state_int(state, "limit", 1),
            min_score=_state_int(state, "minScore", 80),
            strategy=str(state.get("strategy") or "balanced"),
            dry_run=bool(state.get("dryRun")),
            engine_run_id=state.get("engineRunId"),
            database=_database(state, database),
        )
        no_more = int(result.get("writingTaskCount") or 0) == 0
        return {**state, "topicsSelect": result, "noMoreCandidates": no_more}

    def generate_articles_node(state: dict[str, Any]) -> dict[str, Any]:
        from contentflow.domains.production.article_generation import generate_articles_from_writing_tasks

        result = generate_articles_from_writing_tasks(
            limit=_state_int(state, "limit", 1),
            include_failed=bool(state.get("includeFailed")),
            engine_run_id=state.get("engineRunId"),
            database=_database(state, database),
        )
        attempted = int(result.get("succeeded") or 0) + int(result.get("failed") or 0)
        no_more = attempted == 0
        return {
            **state,
            "articlesGenerate": result,
            "attempts": int(state.get("attempts") or 0) + attempted,
            "lastAttempted": attempted,
            "lastGenerated": int(result.get("succeeded") or 0),
            "noMoreCandidates": bool(state.get("noMoreCandidates")) or no_more,
        }

    def factcheck_articles_node(state: dict[str, Any]) -> dict[str, Any]:
        if int(state.get("lastGenerated") or 0) <= 0:
            return {**state, "articlesFactcheck": {"ok": True, "skipped": True}}
        from contentflow.domains.production.factcheck import factcheck_articles_for_review_gate

        result = factcheck_articles_for_review_gate(
            limit=max(_state_int(state, "limit", 1), _state_int(state, "targetReady", 1)),
            engine_run_id=state.get("engineRunId"),
            database=_database(state, database),
        )
        return {**state, "articlesFactcheck": result}

    def refresh_counts_node(state: dict[str, Any]) -> dict[str, Any]:
        engine_run_id = state.get("engineRunId")
        if not engine_run_id:
            return state
        database_obj = _database(state, database)
        rows = database_obj.query("SELECT COUNT(*) c FROM articles WHERE engine_run_id = %s AND status = 'ready_for_review'", [engine_run_id])
        ready_count = int((rows[0] if rows else {}).get("c") or 0)
        return {**state, "readyCount": ready_count}

    def score_seo_geo_node(state: dict[str, Any]) -> dict[str, Any]:
        if bool(state.get("skipSeoGeoScore")) or int(state.get("readyCount") or 0) <= 0:
            return {**state, "scoreSeoGeo": {"ok": True, "skipped": True}}
        from contentflow.domains.production.scoring import run_scores

        result = run_scores(
            status="ready_for_review",
            strategy=str(state.get("strategy") or "balanced"),
            engine_run_id=state.get("engineRunId"),
            database=_database(state, database),
        )
        return {**state, "scoreSeoGeo": result}

    def channels_generate_node(state: dict[str, Any]) -> dict[str, Any]:
        if int(state.get("readyCount") or 0) <= 0:
            return {**state, "channelsGenerate": {"ok": True, "skipped": True}}
        from contentflow.domains.production.channels import run_channels

        result = run_channels(
            status="ready_for_review",
            missing_only=True,
            engine_run_id=state.get("engineRunId"),
            database=_database(state, database),
        )
        return {**state, "channelsGenerate": result}

    def db_list_node(state: dict[str, Any]) -> dict[str, Any]:
        database_obj = _database(state, database)
        rows = database_obj.query(
            "SELECT id, title, status, article_quality_score, seo_score, geo_score, created_at FROM articles ORDER BY created_at DESC LIMIT %s",
            [_state_int(state, "limit", 1)],
        )
        return {**state, "dbList": {"ok": True, "items": rows, "count": len(rows)}}

    def after_select_topics(state: dict[str, Any]) -> str:
        return "refresh_counts" if bool(state.get("noMoreCandidates")) else "generate_articles"

    def after_refresh_counts(state: dict[str, Any]) -> str:
        return "score_seo_geo" if should_finish_quota_loop(state) else "select_topics"

    graph = StateGraph(dict)
    graph.add_node("collect_sources", collect_sources_node)
    graph.add_node("generate_topics", generate_topics_node)
    graph.add_node("select_topics", select_topics_node)
    graph.add_node("generate_articles", generate_articles_node)
    graph.add_node("factcheck_articles", factcheck_articles_node)
    graph.add_node("refresh_counts", refresh_counts_node)
    graph.add_node("score_seo_geo", score_seo_geo_node)
    graph.add_node("channels_generate", channels_generate_node)
    graph.add_node("db_list", db_list_node)
    graph.add_edge(START, "collect_sources")
    graph.add_edge("collect_sources", "generate_topics")
    graph.add_edge("generate_topics", "select_topics")
    graph.add_conditional_edges("select_topics", after_select_topics, {"generate_articles": "generate_articles", "refresh_counts": "refresh_counts"})
    graph.add_edge("generate_articles", "factcheck_articles")
    graph.add_edge("factcheck_articles", "refresh_counts")
    graph.add_conditional_edges("refresh_counts", after_refresh_counts, {"select_topics": "select_topics", "score_seo_geo": "score_seo_geo"})
    graph.add_edge("score_seo_geo", "channels_generate")
    graph.add_edge("channels_generate", "db_list")
    graph.add_edge("db_list", END)
    return graph.compile()
