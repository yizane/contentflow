from __future__ import annotations

import re
import time
from typing import Any
from urllib.parse import urljoin, urlsplit

import feedparser
import httpx
from bs4 import BeautifulSoup
from trafilatura import extract as extract_main_text

from contentflow.core import config, db
from contentflow.domains.sources import lanes
from contentflow.domains.sources.collectors.amz123 import collect_amz123_kx_api
from contentflow.domains.sources.ingest import ingest_collected_sources

FETCH_TIMEOUT = 12
MAX_ITEMS_PER_FEED = 8
MAX_LINKS_PER_PAGE = 8
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) flyfus-content-agent/0.3 source-collector"


def is_amz_kx_source(source: dict[str, Any]) -> bool:
    return bool(re.search(r"https?://(?:www\.)?amz123\.com/kx\b", str(source.get("url") or ""), flags=re.I))


def _clean_text(value: Any) -> str:
    return " ".join(BeautifulSoup(str(value or ""), "html.parser").get_text(" ").split())


def _main_text(html: str) -> str:
    extracted = extract_main_text(html, include_comments=False, include_tables=False, favor_precision=True)
    return " ".join(str(extracted or "").split())


def _source_item(source: dict[str, Any], *, title: str, url: str, published_at: str = "", summary: str = "", content_text: str = "", item_type: str = "fetch_page") -> dict[str, Any]:
    return {
        "title": title,
        "url": url,
        "publishedAt": published_at,
        "summary": summary[:800],
        "contentText": (content_text or summary)[:8000],
        "sourceName": source.get("name"),
        "sourceGroup": source.get("group"),
        "sourceCategory": source.get("category"),
        "sourceLane": source.get("lane"),
        "sourcePriority": source.get("priority"),
        "sourceFreshness": source.get("freshness"),
        "itemType": item_type,
    }


def fetch_text(client: httpx.Client, url: str) -> str:
    response = client.get(url, headers={"User-Agent": UA, "Accept": "*/*"})
    response.raise_for_status()
    return response.text[:1_500_000]


def parse_feed(text: str, source: dict[str, Any]) -> list[dict[str, Any]]:
    parsed = feedparser.parse(text)
    items: list[dict[str, Any]] = []
    for entry in parsed.entries[:MAX_ITEMS_PER_FEED]:
        title = _clean_text(entry.get("title"))
        link = entry.get("link") or entry.get("id") or ""
        if not title and not link:
            continue
        published = entry.get("published") or entry.get("updated") or ""
        summary = _clean_text(entry.get("summary") or entry.get("description") or entry.get("content", ""))
        items.append(_source_item(source, title=title, url=link, published_at=published, summary=summary, item_type="atom" if parsed.version and "atom" in parsed.version.lower() else "rss"))
    return items


def parse_page(text: str, source: dict[str, Any]) -> list[dict[str, Any]]:
    soup = BeautifulSoup(text, "html.parser")
    page_text = _main_text(text)
    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    base_url = source.get("url") or ""
    origin = ""
    try:
        parts = urlsplit(base_url)
        origin = f"{parts.scheme}://{parts.netloc}"
    except Exception:
        origin = ""
    for anchor in soup.find_all("a", href=True):
        if len(items) >= MAX_LINKS_PER_PAGE:
            break
        title = _clean_text(anchor.get_text(" "))
        if len(title) < 12 or len(title) > 160:
            continue
        href = urljoin(base_url, anchor["href"])
        if not href or href in seen:
            continue
        if origin and not href.startswith(origin):
            continue
        seen.add(href)
        items.append(_source_item(source, title=title, url=href))
    if not items:
        title = _clean_text(soup.title.string if soup.title else source.get("name") or "")
        if title and base_url:
            items.append(_source_item(source, title=title, url=base_url, summary=page_text[:800] or "(page-level item)", content_text=page_text))
    return items


def collect_http_sources(*, daily_key: str | None = None, sources: list[dict[str, Any]] | None = None, db_client: Any | None = None, client: httpx.Client | None = None) -> dict[str, Any]:
    source_items = sources if sources is not None else config.get_source_items(db_client=db_client)
    http_sources = [source for source in source_items if source.get("type") != "search_query"]
    owns_client = client is None
    client = client or httpx.Client(timeout=FETCH_TIMEOUT, follow_redirects=True)
    warnings: list[str] = []
    summary = {"total": 0, "rss": 0, "atom": 0, "fetchPage": 0, "searchQuery": 0, "skipped": 0, "failed": 0}
    items: list[dict[str, Any]] = []
    per_source: list[dict[str, Any]] = []
    daily_key = daily_key or runtime_daily_key()
    try:
        for source in http_sources:
            started = time.monotonic()
            if lanes.bool_value(source.get("requires_auth"), False):
                summary["skipped"] += 1
                warnings.append(f"skipped（requires_auth）: {source.get('name')}")
                per_source.append({"source": source, "status": "skipped", "httpStatus": None, "itemsFound": 0, "durationMs": 0, "warningMessage": "requires_auth=true，自动采集跳过"})
                continue
            try:
                got: list[dict[str, Any]] = []
                source_type = source.get("type")
                if source_type in {"rss", "atom", "discover_feed_or_fetch"}:
                    text = fetch_text(client, source.get("url") or "")
                    got = parse_feed(text, source)
                    if not got and source_type == "discover_feed_or_fetch":
                        got = parse_page(text, source)
                    for item in got:
                        if item["itemType"] == "atom":
                            summary["atom"] += 1
                        elif item["itemType"] == "rss":
                            summary["rss"] += 1
                        else:
                            summary["fetchPage"] += 1
                elif source_type == "fetch_page":
                    if is_amz_kx_source(source):
                        got = collect_amz123_kx_api(source, daily_key=daily_key, client=client)
                    else:
                        got = parse_page(fetch_text(client, source.get("url") or ""), source)
                    summary["fetchPage"] += len(got)
                items.extend(got)
                per_source.append({
                    "source": source,
                    "status": "success" if got else "partial",
                    "httpStatus": 200,
                    "itemsFound": len(got),
                    "durationMs": int((time.monotonic() - started) * 1000),
                    "sampleTitles": [item["title"][:80] for item in got[:3]],
                    "warningMessage": None if got else "抓取成功但未提取到条目",
                })
            except Exception as exc:
                summary["failed"] += 1
                message = str(exc)
                warnings.append(f"failed: {source.get('name')} — {message}")
                status = getattr(getattr(exc, "response", None), "status_code", None)
                per_source.append({"source": source, "status": "failed", "httpStatus": status, "itemsFound": 0, "durationMs": int((time.monotonic() - started) * 1000), "errorMessage": message})
    finally:
        if owns_client:
            client.close()
    summary["total"] = len(items)
    return {"items": items, "summary": summary, "warnings": warnings, "perSource": per_source}


def runtime_daily_key() -> str:
    from datetime import datetime
    from zoneinfo import ZoneInfo

    return datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d")


def collect_sources(*, engine_run_id: str | None = None, daily_key: str | None = None, database: Any | None = None, sources: list[dict[str, Any]] | None = None, client: httpx.Client | None = None) -> dict[str, Any]:
    database = database or db.Database()
    daily_key = daily_key or _daily_key_for_run(database, engine_run_id)
    collected = collect_http_sources(daily_key=daily_key, sources=sources, db_client=database, client=client)
    ingest = ingest_collected_sources(items=collected["items"], engine_run_id=engine_run_id, daily_key=daily_key, now=db.now(), database=database)
    summary = {
        **collected["summary"],
        "total": ingest["observations"],
        "inserted": ingest["insertedSources"],
        "duplicatesHistorical": ingest["seenSources"],
        "reactivated": ingest["reactivatedSources"],
        "ignored": ingest["ignored"],
    }
    return {"ok": True, "engineRunId": engine_run_id, "summary": summary, "warnings": [*collected["warnings"], *ingest["warnings"]], "perSource": collected["perSource"]}


def _daily_key_for_run(database: Any, engine_run_id: str | None) -> str | None:
    if not engine_run_id:
        return None
    rows = database.query("SELECT daily_key FROM engine_runs WHERE id = %s LIMIT 1", [engine_run_id])
    return rows[0].get("daily_key") if rows else None
