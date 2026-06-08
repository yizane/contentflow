from contentflow.flow import graph


def test_graph_dry_run_plan_contains_current_main_chain():
    plan = graph.build_graph_dry_run_plan(
        limit=1,
        target_ready=5,
        max_attempts=15,
        min_score=80,
        strategy="balanced",
        skip_seo_geo_score=False,
    )

    assert [step["name"] for step in plan] == [
        "sources:collect",
        "topics:generate",
        "quota:loop",
        "topics:select",
        "articles:generate",
        "articles:factcheck",
        "score:seo-geo",
        "channels:generate",
        "db:list",
    ]
    assert [step["stepKey"] for step in plan[:6]] == [
        "sources_collect",
        "topics_generate",
        "quota_loop",
        "topics_select",
        "articles_generate",
        "articles_factcheck",
    ]


def test_should_finish_quota_loop_conditions():
    assert graph.should_finish_quota_loop({"readyCount": 5, "targetReady": 5, "attempts": 0, "maxAttempts": 15}) is True
    assert graph.should_finish_quota_loop({"readyCount": 0, "targetReady": 5, "attempts": 0, "maxAttempts": 15, "noMoreCandidates": True}) is True
    assert graph.should_finish_quota_loop({"readyCount": 0, "targetReady": 5, "attempts": 15, "maxAttempts": 15}) is True
    assert graph.should_finish_quota_loop({"readyCount": 0, "targetReady": 5, "attempts": 1, "maxAttempts": 15}) is False
    assert graph.should_finish_quota_loop({"readyCount": 0, "attempts": 0}) is False
