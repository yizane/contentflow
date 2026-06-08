from __future__ import annotations

import json
from typing import Any

LANE_RANK = {"knowledge": 1, "news": 2, "policy": 3}


def bool_value(value: Any, default: bool = True) -> bool:
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    text = str(value).strip().lower()
    if text in {"false", "0", "no", "off", "disabled"}:
        return False
    if text in {"true", "1", "yes", "on", "enabled"}:
        return True
    return default


def parse_extra_json(value: Any) -> dict[str, Any]:
    if not value:
        return {}
    if isinstance(value, dict):
        return value
    try:
        parsed = json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def is_source_enabled(source: dict[str, Any]) -> bool:
    return bool_value(source.get("enabled"), True)


def should_run_daily_query(source: dict[str, Any]) -> bool:
    if source.get("type") != "search_query":
        return True
    return bool_value(source.get("daily_query_enabled"), True)


def lane_from_freshness(freshness: str | None) -> str:
    if freshness == "breaking_news":
        return "news"
    if freshness == "policy_update":
        return "policy"
    if freshness == "evergreen_blog":
        return "knowledge"
    return "knowledge"


def resolve_source_lane(source: dict[str, Any] | None = None) -> str:
    source = source or {}
    lane = source.get("lane") or source.get("sourceLane") or source.get("source_lane")
    if lane in LANE_RANK:
        return lane
    name = str(source.get("name") or source.get("sourceName") or "").lower()
    category = source.get("category") or source.get("sourceCategory")
    freshness = source.get("freshness")

    if any(part in name for part in ["resources library", "search engine journal", "google ai blog", "perplexity"]):
        return "knowledge"
    if category in {"seller_tool_blog", "chinese_crossborder_report"}:
        return "knowledge"
    if category in {"official_policy", "official_search"} or "seller central news" in name or "seller forums" in name:
        return "policy"
    if category == "amazon_ads" and freshness == "policy_update" and "resources library" not in name:
        return "policy"
    return lane_from_freshness(freshness)


def stronger_lane(a: str | None, b: str | None) -> str:
    left = a if a in LANE_RANK else "knowledge"
    right = b if b in LANE_RANK else "knowledge"
    return right if LANE_RANK[right] > LANE_RANK[left] else left


def source_priority_score(source: dict[str, Any] | None = None) -> int:
    priority = str((source or {}).get("priority") or "").lower()
    if priority in {"high", "p0"}:
        return 30
    if priority in {"medium", "p1"}:
        return 20
    if priority in {"low", "p2"}:
        return 10
    return 15

