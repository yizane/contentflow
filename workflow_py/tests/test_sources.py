from __future__ import annotations

import json

import httpx

from contentflow.domains.sources.collect import collect_http_sources
from contentflow.domains.sources.collectors.amz123 import collect_amz123_kx_api, shanghai_day_window
from contentflow.domains.sources.identity import canonicalize_url, jaccard, normalized_topic
from contentflow.domains.sources.ingest import ingest_collected_sources, plan_source_ingest


def test_canonicalize_url_removes_tracking_and_sorts_query():
    url = canonicalize_url("HTTPS://Example.COM/path/?utm_source=x&b=2&a=1&fbclid=bad#frag")
    assert url == "https://example.com/path?a=1&b=2"


def test_canonicalize_url_uses_library_normalization_for_default_ports():
    url = canonicalize_url("HTTP://Example.COM:80/path/?utm_campaign=x&b=2&a=1#frag")
    assert url == "http://example.com/path?a=1&b=2"


def test_mixed_chinese_english_similarity_and_topic_normalize():
    assert normalized_topic(" Prime Day  广告 / ACoS ") == "primeday广告acos"
    assert jaccard("亚马逊广告 ACoS 怎么降", "亚马逊广告 ACoS 降本") > 0.35


def test_similarity_uses_fuzzy_matching_for_near_duplicate_topics():
    left = "亚马逊关闭差评买家主动联系入口后，卖家如何重建差评处理 SOP"
    right = "亚马逊关闭差评买家联系入口后，卖家怎么用评论和Q&A降低差评率"
    assert jaccard(left, right) > 0.55


def test_plan_source_ingest_marks_same_url_as_seen():
    item = {
        "title": "亚马逊关闭差评买家主动联系入口",
        "url": "https://www.amz123.com/kx/123?utm_source=x",
        "sourceName": "AMZ123 快讯",
        "sourceGroup": "news",
        "sourceLane": "news",
    }
    first = plan_source_ingest([item], now="2026-06-06 00:00:00.000")
    existing = {
        first["observations"][0]["canonical_url_hash"]: {
            "source_item_id": "source_existing",
            "lane": "news",
            "content_fingerprint": first["observations"][0]["fingerprint"],
        }
    }
    second = plan_source_ingest([item], existing, now="2026-06-07 00:00:00.000")

    assert len(first["newSources"]) == 1
    assert len(second["seenSources"]) == 1
    assert second["seenSources"][0]["observation_status"] == "seen_source"


def test_amz123_kx_collector_uses_shanghai_window_and_dedupes_items():
    requests: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(json.loads(request.content.decode()))
        return httpx.Response(200, json={
            "status": 0,
            "data": {
                "row_map": {
                    "2026-06-01": [{
                        "kx_content": [
                            {"id": 1, "title": "亚马逊新政策", "published_at": 1780329600, "description": "desc"},
                            {"id": 1, "title": "亚马逊新政策", "published_at": 1780329600, "description": "desc"},
                            {"id": 2, "title": "", "published_at": 1780329600},
                        ]
                    }]
                }
            },
        })

    client = httpx.Client(transport=httpx.MockTransport(handler))
    items = collect_amz123_kx_api(
        {"name": "AMZ123 快讯", "group": "news", "category": "crossborder_news", "lane": "news"},
        daily_key="2026-06-01",
        client=client,
    )

    assert requests[0]["start_time"] == shanghai_day_window("2026-06-01")["start"]
    assert requests[0]["end_time"] == shanghai_day_window("2026-06-01")["end"]
    assert len(items) == 1
    assert items[0]["url"] == "https://www.amz123.com/kx/1"
    assert items[0]["sourceName"] == "AMZ123 快讯"


def test_ingest_collected_sources_writes_source_observation_and_canonical():
    class FakeDB:
        def __init__(self):
            self.inserts = []
            self.queries = []

        def query(self, sql, params=None):
            self.queries.append((sql, params or []))
            if "SELECT * FROM source_canonical_items" in sql:
                return []
            return []

        def insert(self, table, data):
            self.inserts.append((table, data))

        def update(self, *_args, **_kwargs):
            raise AssertionError("new source ingest should not update")

    fake = FakeDB()
    result = ingest_collected_sources(
        items=[{
            "title": "亚马逊新政策",
            "url": "https://www.amz123.com/kx/1",
            "summary": "政策摘要",
            "contentText": "政策正文细节",
            "sourceName": "AMZ123 快讯",
            "sourceGroup": "news",
            "sourceLane": "news",
        }],
        engine_run_id="engine_test",
        daily_key="2026-06-01",
        now="2026-06-01 00:00:00.000",
        database=fake,
    )

    assert result["observations"] == 1
    assert result["insertedSources"] == 1
    assert {table for table, _ in fake.inserts} == {"source_items", "source_observations"}
    source_insert = next(data for table, data in fake.inserts if table == "source_items")
    assert source_insert["content_text"] == "政策正文细节"
    assert any("INSERT INTO source_canonical_items" in sql for sql, _ in fake.queries)


def test_collect_http_sources_uses_feedparser_and_bs4_page_parser():
    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url).endswith("/feed.xml"):
            return httpx.Response(200, text="""<?xml version="1.0"?><rss><channel><item><title>Amazon fee update</title><link>https://example.com/a</link><description>desc</description></item></channel></rss>""")
        return httpx.Response(200, text="""<html><head><title>Blog</title></head><body><a href="/post">Amazon sellers prepare for Prime Day advertising</a></body></html>""")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    result = collect_http_sources(
        daily_key="2026-06-01",
        sources=[
            {"name": "Feed", "group": "g", "type": "rss", "url": "https://example.com/feed.xml", "requires_auth": False},
            {"name": "Page", "group": "g", "type": "fetch_page", "url": "https://example.com", "requires_auth": False},
        ],
        client=client,
    )

    assert result["summary"]["total"] == 2
    assert result["summary"]["rss"] == 1
    assert result["summary"]["fetchPage"] == 1
    assert [row["status"] for row in result["perSource"]] == ["success", "success"]


def test_page_parser_uses_article_extraction_for_page_level_summary():
    html = """
    <html>
      <head><title>Amazon seller update</title></head>
      <body>
        <article>
          <h1>Amazon seller update</h1>
          <p>Amazon sellers need to adjust compliance workflows before the July certificate filing change.</p>
          <p>This page contains useful operational detail for FBA teams.</p>
        </article>
      </body>
    </html>
    """

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=html)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    result = collect_http_sources(
        daily_key="2026-06-01",
        sources=[{"name": "Page", "group": "g", "type": "fetch_page", "url": "https://example.com/post", "requires_auth": False}],
        client=client,
    )

    assert result["summary"]["total"] == 1
    assert "compliance workflows" in result["items"][0]["summary"]
