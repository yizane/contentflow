from __future__ import annotations

import html
from datetime import datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

import httpx
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

AMZ123_KX_API = "https://api.amz123.com/ugc/v1/user_content/kx_list"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) flyfus-content-agent/0.3 source-collector"
SHANGHAI = ZoneInfo("Asia/Shanghai")


def decode_entities(value: str | None) -> str:
    return " ".join(html.unescape(str(value or "")).split())


def shanghai_day_window(daily_key: str) -> dict[str, int]:
    start = datetime.fromisoformat(f"{daily_key}T00:00:00+08:00")
    end = datetime.fromisoformat(f"{daily_key}T23:59:59+08:00")
    return {"start": int(start.timestamp()), "end": int(end.timestamp())}


def shanghai_datetime_from_epoch(seconds: int | str | None) -> str:
    if not seconds:
        return ""
    return datetime.fromtimestamp(int(seconds), tz=timezone.utc).astimezone(SHANGHAI).strftime("%Y-%m-%d %H:%M:%S")


def flatten_kx_rows(data: dict[str, Any] | None) -> list[dict[str, Any]]:
    row_map = (data or {}).get("row_map") or {}
    out: list[dict[str, Any]] = []
    for value in row_map.values():
        rows = value if isinstance(value, list) else [value]
        for row in rows:
            for item in (row or {}).get("kx_content") or []:
                if isinstance(item, dict):
                    out.append(item)
    return out


@retry(
    retry=retry_if_exception_type((httpx.TimeoutException, httpx.TransportError)),
    wait=wait_exponential(multiplier=0.25, min=0.25, max=2),
    stop=stop_after_attempt(3),
    reraise=True,
)
def fetch_kx_json(client: httpx.Client, payload: dict[str, Any]) -> dict[str, Any]:
    response = client.post(
        AMZ123_KX_API,
        json=payload,
        headers={
            "User-Agent": UA,
            "accept": "application/json",
            "content-type": "application/json",
            "app-id": "3",
            "project-id": "ugc",
            "Origin": "https://www.amz123.com",
            "Referer": "https://www.amz123.com/",
        },
    )
    response.raise_for_status()
    return response.json()


def collect_amz123_kx_api(source: dict[str, Any], *, daily_key: str, client: httpx.Client | None = None) -> list[dict[str, Any]]:
    window = shanghai_day_window(daily_key)
    payload = {
        "is_important": -1,
        "category_id": 0,
        "start_time": window["start"],
        "end_time": window["end"],
        "keyword": "",
        "is_query_zb": 0,
        "is_query_total_count": 1,
    }
    owns_client = client is None
    client = client or httpx.Client(timeout=12, follow_redirects=True)
    try:
        data = fetch_kx_json(client, payload)
    finally:
        if owns_client:
            client.close()
    if data.get("status") != 0:
        raise RuntimeError(f"AMZ123 kx API status {data.get('status')}: {data.get('info') or data.get('message') or 'unknown'}")

    seen: set[str] = set()
    items: list[dict[str, Any]] = []
    for row in flatten_kx_rows(data.get("data")):
        item_id = row.get("id") or str(row.get("resource_id") or "")
        url = f"https://www.amz123.com/kx/{item_id}" if item_id else ""
        title = decode_entities(row.get("title"))
        if not item_id or not url or not title or url in seen:
            continue
        seen.add(url)
        items.append({
            "title": title,
            "url": url,
            "publishedAt": shanghai_datetime_from_epoch(row.get("published_at")),
            "summary": decode_entities(row.get("description") or row.get("content"))[:800],
            "sourceName": source.get("name"),
            "sourceGroup": source.get("group"),
            "sourceCategory": source.get("category"),
            "sourceLane": source.get("lane"),
            "sourcePriority": source.get("priority"),
            "sourceFreshness": source.get("freshness"),
            "itemType": "fetch_page",
            "rawJson": {"crawler": "amz123_kx_api", "dailyKey": daily_key, "endpoint": AMZ123_KX_API, "apiItem": row},
        })
    return items

