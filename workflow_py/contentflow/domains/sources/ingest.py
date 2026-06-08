from __future__ import annotations

from typing import Any, Callable

from contentflow.core import db
from contentflow.domains.sources.identity import canonical_url_hash, canonicalize_url, sha256
from contentflow.domains.sources.lanes import resolve_source_lane, stronger_lane


def source_name_of(item: dict[str, Any]) -> str:
    return item.get("sourceName") or item.get("source_name") or item.get("name") or "unknown_source"


def source_group_of(item: dict[str, Any]) -> str:
    return item.get("sourceGroup") or item.get("source_group") or item.get("group") or "unknown_group"


def source_category_of(item: dict[str, Any]) -> str | None:
    return item.get("sourceCategory") or item.get("source_category") or item.get("category")


def item_url_of(item: dict[str, Any]) -> str:
    return item.get("url") or item.get("source_url") or ""


def content_fingerprint(item: dict[str, Any]) -> str:
    return sha256("\n".join([
        str(item.get("title") or ""),
        str(item.get("summary") or ""),
        str(item.get("content_text") or item.get("contentText") or ""),
    ]).strip())


def normalize_collected_item(item: dict[str, Any], now: str) -> dict[str, Any]:
    source_url = item_url_of(item)
    canonical_url = canonicalize_url(source_url)
    lane = resolve_source_lane({
        **item,
        "name": source_name_of(item),
        "category": source_category_of(item),
        "lane": item.get("sourceLane") or item.get("source_lane") or item.get("lane"),
    })
    return {
        "source_url": source_url,
        "canonical_url": canonical_url,
        "canonical_url_hash": canonical_url_hash(canonical_url),
        "source_lane": lane,
        "source_name": source_name_of(item),
        "source_group": source_group_of(item),
        "source_category": source_category_of(item),
        "source_type": item.get("itemType") or item.get("source_type") or item.get("type"),
        "title": str(item.get("title") or "")[:510],
        "summary": item.get("summary"),
        "content_text": item.get("content_text") or item.get("contentText") or None,
        "published_at": str(item.get("publishedAt") or item.get("published_at") or item.get("as_of") or "")[:64] or None,
        "retrieved_at": now,
        "fingerprint": content_fingerprint(item),
        "raw": item,
    }


def plan_source_ingest(items: list[dict[str, Any]], existing_by_hash: dict[str, dict[str, Any]] | None = None, *, now: str = "2026-06-06 00:00:00.000") -> dict[str, Any]:
    seen = dict(existing_by_hash or {})
    observations: list[dict[str, Any]] = []
    new_sources: list[dict[str, Any]] = []
    seen_sources: list[dict[str, Any]] = []
    ignored: list[dict[str, Any]] = []

    for item in items or []:
        row = normalize_collected_item(item, now)
        if not row["source_url"] or not row["canonical_url"]:
            ignored.append({"item": item, "reason": "missing_url"})
            continue
        existing = seen.get(row["canonical_url_hash"])
        if existing:
            status = "reactivated_source" if existing.get("lane") == "policy" and existing.get("content_fingerprint") and existing["content_fingerprint"] != row["fingerprint"] else "seen_source"
            observation = {**row, "source_item_id": existing["source_item_id"], "observation_status": status}
            observations.append(observation)
            seen_sources.append(observation)
            seen[row["canonical_url_hash"]] = {**existing, "lane": stronger_lane(existing.get("lane"), row["source_lane"]), "content_fingerprint": row["fingerprint"]}
        else:
            source_item_id = f"source_{len(new_sources) + 1:04d}"
            observation = {**row, "source_item_id": source_item_id, "observation_status": "new_source"}
            observations.append(observation)
            new_sources.append(observation)
            seen[row["canonical_url_hash"]] = {
                "canonical_url_hash": row["canonical_url_hash"],
                "source_item_id": source_item_id,
                "lane": row["source_lane"],
                "content_fingerprint": row["fingerprint"],
            }
    return {"observations": observations, "newSources": new_sources, "seenSources": seen_sources, "ignored": ignored}


def insert_observation(database: Any, row: dict[str, Any], *, engine_run_id: str | None, daily_key: str | None, now: str, source_item_id: str | None, status: str, duplicate_reason: str | None = None) -> str:
    observation_id = db.make_id("sobs")
    database.insert("source_observations", {
        "id": observation_id,
        "engine_run_id": engine_run_id,
        "daily_key": daily_key,
        "source_item_id": source_item_id,
        "canonical_url_hash": row["canonical_url_hash"],
        "source_name": row["source_name"],
        "source_group": row["source_group"],
        "source_url": row["source_url"],
        "canonical_url": row["canonical_url"],
        "source_lane": row["source_lane"],
        "title": row["title"],
        "summary": row["summary"],
        "published_at": row["published_at"],
        "retrieved_at": now,
        "observation_status": status,
        "duplicate_reason": duplicate_reason,
        "raw_json": row["raw"],
        "created_at": now,
    })
    return observation_id


def insert_source_item(database: Any, row: dict[str, Any], *, engine_run_id: str | None, now: str, trust_of: Callable[[str | None], Any] | None = None) -> str:
    source_item_id = db.make_id("source")
    database.insert("source_items", {
        "id": source_item_id,
        "engine_run_id": engine_run_id,
        "source_name": row["source_name"],
        "source_group": row["source_group"],
        "source_url": row["source_url"],
        "source_type": row["source_type"],
        "source_trust": trust_of(row["source_category"]) if trust_of else None,
        "title": row["title"],
        "summary": row["summary"],
        "content_text": row["content_text"],
        "retrieved_at": now,
        "as_of": row["published_at"][:32] if row["published_at"] else None,
        "raw_json": row["raw"],
        "created_at": now,
    })
    return source_item_id


def upsert_canonical(database: Any, row: dict[str, Any], *, source_item_id: str, observation_id: str, engine_run_id: str | None, now: str, existing: dict[str, Any] | None = None) -> str:
    if existing:
        promoted = stronger_lane(existing.get("lane"), row["source_lane"])
        database.query(
            """
            UPDATE source_canonical_items
            SET last_seen_at = %s,
                seen_count = seen_count + 1,
                lane = %s,
                last_engine_run_id = %s,
                last_observation_id = %s,
                updated_at = %s
            WHERE canonical_url_hash = %s
            """,
            [now, promoted, engine_run_id, observation_id, now, row["canonical_url_hash"]],
        )
        return promoted

    database.query(
        """
        INSERT INTO source_canonical_items (
          canonical_url_hash, canonical_url, source_item_id, first_seen_at, last_seen_at,
          seen_count, source_count, lane, usage_status, times_in_prompt, content_fingerprint,
          last_engine_run_id, last_observation_id, created_at, updated_at
        ) VALUES (%s, %s, %s, %s, %s, 1, 1, %s, 'unused', 0, %s, %s, %s, %s, %s)
        ON DUPLICATE KEY UPDATE
          last_seen_at = VALUES(last_seen_at),
          seen_count = seen_count + 1,
          lane = CASE
            WHEN lane = 'policy' OR VALUES(lane) = 'policy' THEN 'policy'
            WHEN lane = 'news' OR VALUES(lane) = 'news' THEN 'news'
            ELSE 'knowledge'
          END,
          last_engine_run_id = VALUES(last_engine_run_id),
          last_observation_id = VALUES(last_observation_id),
          updated_at = VALUES(updated_at)
        """,
        [row["canonical_url_hash"], row["canonical_url"], source_item_id, now, now, row["source_lane"], row["fingerprint"], engine_run_id, observation_id, now, now],
    )
    return row["source_lane"]


def ingest_collected_sources(*, items: list[dict[str, Any]], engine_run_id: str | None = None, daily_key: str | None = None, now: str | None = None, trust_of: Callable[[str | None], Any] | None = None, database: Any | None = None) -> dict[str, Any]:
    database = database or db.Database()
    now = now or db.now()
    result = {
        "observations": 0,
        "insertedSources": 0,
        "seenSources": 0,
        "reactivatedSources": 0,
        "ignored": 0,
        "insertedRows": [],
        "insertedBySource": {},
        "observedBySource": {},
        "warnings": [],
    }
    for item in items or []:
        row = normalize_collected_item(item, now)
        if not row["source_url"] or not row["canonical_url"]:
            result["ignored"] += 1
            continue
        existing_rows = database.query("SELECT * FROM source_canonical_items WHERE canonical_url_hash = %s LIMIT 1", [row["canonical_url_hash"]])
        existing = existing_rows[0] if existing_rows else None
        if existing:
            is_reactivated = stronger_lane(existing.get("lane"), row["source_lane"]) == "policy" and existing.get("content_fingerprint") and existing["content_fingerprint"] != row["fingerprint"]
            if is_reactivated:
                database.update("source_canonical_items", {"content_fingerprint": row["fingerprint"], "reactivated_at": now, "updated_at": now}, "canonical_url_hash = %s", [row["canonical_url_hash"]])
                database.update("source_items", {"title": row["title"], "summary": row["summary"], "content_text": row["content_text"], "retrieved_at": now, "as_of": row["published_at"][:32] if row["published_at"] else None, "raw_json": row["raw"]}, "id = %s", [existing["source_item_id"]])
            status = "reactivated_source" if is_reactivated else "seen_source"
            observation_id = insert_observation(database, row, engine_run_id=engine_run_id, daily_key=daily_key, now=now, source_item_id=existing["source_item_id"], status=status)
            upsert_canonical(database, row, source_item_id=existing["source_item_id"], observation_id=observation_id, engine_run_id=engine_run_id, now=now, existing=existing)
            result["observations"] += 1
            result["observedBySource"][row["source_name"]] = result["observedBySource"].get(row["source_name"], 0) + 1
            result["seenSources"] += 1
            if is_reactivated:
                result["reactivatedSources"] += 1
            continue

        source_item_id = insert_source_item(database, row, engine_run_id=engine_run_id, now=now, trust_of=trust_of)
        observation_id = insert_observation(database, row, engine_run_id=engine_run_id, daily_key=daily_key, now=now, source_item_id=source_item_id, status="new_source")
        upsert_canonical(database, row, source_item_id=source_item_id, observation_id=observation_id, engine_run_id=engine_run_id, now=now)
        result["observations"] += 1
        result["insertedSources"] += 1
        result["observedBySource"][row["source_name"]] = result["observedBySource"].get(row["source_name"], 0) + 1
        result["insertedRows"].append({
            "id": source_item_id,
            "title": row["title"],
            "summary": row["summary"],
            "source_group": row["source_group"],
            "source_name": row["source_name"],
        })
        result["insertedBySource"][row["source_name"]] = result["insertedBySource"].get(row["source_name"], 0) + 1
    return result


def canonical_source_ids_for_urls(urls: list[str], *, database: Any | None = None) -> dict[str, str]:
    database = database or db.Database()
    out: dict[str, str] = {}
    for url in urls or []:
        rows = database.query("SELECT source_item_id FROM source_canonical_items WHERE canonical_url_hash = %s LIMIT 1", [canonical_url_hash(url)])
        if rows:
            out[url] = rows[0]["source_item_id"]
    return out
