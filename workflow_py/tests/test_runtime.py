import pytest

from contentflow.core import db
from contentflow.flow import runtime


def test_engine_now_controls_mysql_datetime():
    normalized = runtime.normalize_engine_now("2026-06-07")
    assert normalized == "2026-06-07T00:00:00.000Z"
    assert runtime.mysql_datetime(normalized) == "2026-06-07 00:00:00.000"


def test_run_id_uses_shanghai_business_day(monkeypatch):
    monkeypatch.setenv("ENGINE_NOW", "2026-06-07T22:45:26Z")

    run_id = db.make_run_id("engine")

    assert run_id.startswith("engine_20260608_064526_")


def test_parse_batch_args_defaults():
    args = runtime.parse_batch_args([
        "--limit", "2",
        "--target-ready", "5",
        "--max-attempts", "3",
        "--strategy", "balanced",
        "--daily-key", "2026-06-07",
        "--as-of-date", "2026-06-07",
        "--skip-seo-geo-score",
    ])

    assert args.limit == 2
    assert args.target_ready == 5
    assert args.max_attempts == 3
    assert args.strategy == "balanced"
    assert args.daily_key == "2026-06-07"
    assert args.engine_now == "2026-06-07T00:00:00.000Z"
    assert args.skip_seo_geo_score is True


def test_parse_batch_args_rejects_invalid_strategy():
    with pytest.raises(ValueError, match="strategy"):
        runtime.parse_batch_args(["--strategy", "invalid"])


def test_build_batch_dry_run_plan_shape():
    args = runtime.parse_batch_args(["--limit", "1", "--target-ready", "5", "--max-attempts", "15"])
    plan = runtime.build_batch_dry_run_plan(args)

    assert plan["limit"] == 1
    assert plan["targetReady"] == 5
    assert plan["maxAttempts"] == 15
    assert [step["stepKey"] for step in plan["steps"]] == [
        "sources_collect",
        "topics_generate",
        "quota_loop",
        "topics_select",
        "articles_generate",
        "articles_factcheck",
        "seo_geo_score",
        "channels_generate",
        "db_list",
    ]
    assert [step["displayName"] for step in plan["steps"][:6]] == [
        "资料采集",
        "候选主题生成",
        "补位循环",
        "选题入选与写作排队",
        "文章初稿生成",
        "事实核查与来源门禁",
    ]
    assert plan["steps"][3]["command"] == "topics:select"
