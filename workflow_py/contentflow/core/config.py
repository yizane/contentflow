from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Any
import csv
import io

import yaml

from . import db
from .db import ROOT
from contentflow.domains.sources import lanes


@lru_cache(maxsize=32)
def read_text_doc(name: str) -> str:
    candidates = [
        ROOT / "config" / f"{name}.yaml",
        ROOT / "prompts" / f"{name}.md",
        ROOT / "schemas" / f"{name}.schema.json",
        ROOT / "schemas" / f"{name}.json",
    ]
    for path in candidates:
        if path.exists():
            return path.read_text(encoding="utf-8")
    raise FileNotFoundError(f"配置文档不存在: {name}")


@lru_cache(maxsize=32)
def read_yaml(name: str) -> dict[str, Any]:
    return yaml.safe_load(read_text_doc(name)) or {}


def root_path(*parts: str) -> Path:
    return ROOT.joinpath(*parts)


def _flatten_yaml_sources(payload: dict[str, Any]) -> list[dict[str, Any]]:
    groups = payload.get("sources") or {}
    out: list[dict[str, Any]] = []
    for group_name, group in groups.items():
        for item in (group or {}).get("items") or []:
            out.append({"group": group_name, **item})
    return out


def get_source_items(*, db_client: Any | None = None) -> list[dict[str, Any]]:
    database = db_client or db.Database()
    try:
        rows = database.query("SELECT * FROM config_sources WHERE enabled = 1")
    except Exception:
        rows = []
    if rows:
        return [{
            **lanes.parse_extra_json(row.get("extra_json")),
            "group": row.get("group_name"),
            "name": row.get("name"),
            "type": row.get("type"),
            "category": row.get("category"),
            "priority": row.get("priority"),
            "url": row.get("url") or None,
            "site_url": row.get("site_url") or None,
            "language": row.get("language") or None,
            "requires_auth": bool(row.get("requires_auth")),
            "freshness": row.get("freshness") or None,
            "query": row.get("query_text") or None,
            "notes": row.get("notes") or None,
            "enabled": bool(row.get("enabled", True)),
        } for row in rows]
    return [source for source in _flatten_yaml_sources(read_yaml("sources")) if lanes.is_source_enabled(source)]


def get_keywords(*, db_client: Any | None = None) -> list[dict[str, Any]]:
    database = db_client or db.Database()
    try:
        rows = database.query("SELECT keyword, cluster, intent, priority, stage, business_angle FROM config_keywords WHERE enabled = 1 ORDER BY priority, keyword")
    except Exception:
        rows = []
    if rows:
        return rows
    path = ROOT / "config" / "keywords.csv"
    if not path.exists():
        return []
    return list(csv.DictReader(io.StringIO(path.read_text(encoding="utf-8"))))


def get_keywords_csv(*, db_client: Any | None = None) -> str:
    rows = get_keywords(db_client=db_client)
    fields = ["keyword", "cluster", "intent", "priority", "stage", "business_angle"]
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=fields, lineterminator="\n")
    writer.writeheader()
    for row in rows:
        writer.writerow({field: row.get(field, "") for field in fields})
    return output.getvalue().strip()


def get_keyword_set(*, db_client: Any | None = None) -> set[str]:
    return {row.get("keyword") for row in get_keywords(db_client=db_client) if row.get("keyword")}
