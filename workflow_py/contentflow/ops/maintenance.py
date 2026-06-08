from __future__ import annotations

import csv
from collections import Counter
from pathlib import Path
from typing import Any

from contentflow.core import config, db
from contentflow.domains.sources.identity import canonical_url_hash, canonicalize_url
from contentflow.domains.sources.ingest import content_fingerprint
from contentflow.domains.sources.lanes import resolve_source_lane


def _bool_value(value: Any, default: bool = True) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() not in {"0", "false", "no", "off", "disabled"}


def config_sync(*, force: bool = False, database: Any | None = None) -> dict[str, Any]:
    database = database or db.Database()
    stats = {
        "docs": {"created": 0, "updated": 0, "unchanged": 0, "skippedWebEdited": []},
        "keywords": {"created": 0, "updated": 0, "unchanged": 0},
        "sources": {"created": 0, "updated": 0, "unchanged": 0},
    }

    def upsert_doc(key: str, doc_type: str, content: str) -> None:
        sha = db.sha256(content)
        existing = database.query("SELECT content_sha256, updated_by, version FROM app_configs WHERE config_key = %s LIMIT 1", [key])
        now = db.now()
        if existing:
            row = existing[0]
            if row.get("content_sha256") == sha:
                stats["docs"]["unchanged"] += 1
                return
            if row.get("updated_by") and row.get("updated_by") != "file-sync" and not force:
                stats["docs"]["skippedWebEdited"].append(key)
                return
            database.update("app_configs", {"content": content, "content_sha256": sha, "version": int(row.get("version") or 0) + 1, "updated_by": "file-sync", "updated_at": now}, "config_key = %s", [key])
            stats["docs"]["updated"] += 1
            return
        database.insert("app_configs", {"config_key": key, "config_type": doc_type, "content": content, "content_sha256": sha, "version": 1, "updated_by": "file-sync", "created_at": now, "updated_at": now})
        stats["docs"]["created"] += 1

    docs: list[tuple[str, str, Path]] = [
        ("internal_claims", "yaml_doc", config.ROOT / "config" / "internal_claims.yaml"),
        ("production_policy", "yaml_doc", config.ROOT / "config" / "production_policy.yaml"),
        ("models", "yaml_doc", config.ROOT / "config" / "models.yaml"),
        ("sources_yaml", "yaml_doc", config.ROOT / "config" / "sources.yaml"),
        ("keywords_csv", "yaml_doc", config.ROOT / "config" / "keywords.csv"),
        ("content_taxonomy", "yaml_doc", config.ROOT / "config" / "content_taxonomy.yaml"),
        ("content_portfolio", "yaml_doc", config.ROOT / "config" / "content_portfolio.yaml"),
    ]
    docs.extend((f"prompt:{path.name}", "prompt", path) for path in sorted((config.ROOT / "prompts").glob("*.md")))
    docs.extend((f"schema:{path.name}", "schema", path) for path in sorted((config.ROOT / "schemas").glob("*.json")))
    for key, doc_type, path in docs:
        if path.exists():
            upsert_doc(key, doc_type, path.read_text(encoding="utf-8"))

    keywords_path = config.ROOT / "config" / "keywords.csv"
    keyword_rows = list(csv.DictReader(keywords_path.read_text(encoding="utf-8").splitlines())) if keywords_path.exists() else []
    for row in keyword_rows:
        keyword = row.get("keyword")
        if not keyword:
            continue
        now = db.now()
        fields = {key: row.get(key) for key in ["cluster", "intent", "priority", "stage", "business_angle"]}
        existing = database.query("SELECT id, cluster, intent, priority, stage, business_angle FROM config_keywords WHERE keyword = %s LIMIT 1", [keyword])
        if existing:
            old = existing[0]
            if all(str(old.get(key) or "") == str(fields.get(key) or "") for key in fields):
                stats["keywords"]["unchanged"] += 1
            else:
                database.update("config_keywords", {**fields, "updated_at": now}, "id = %s", [old["id"]])
                stats["keywords"]["updated"] += 1
        else:
            database.insert("config_keywords", {"id": db.make_id("kw"), "keyword": keyword, **fields, "enabled": 1, "created_at": now, "updated_at": now})
            stats["keywords"]["created"] += 1

    raw_sources = config._flatten_yaml_sources(config.read_yaml("sources"))  # noqa: SLF001 - tool syncs repository seed.
    for source in raw_sources:
        if not source.get("name"):
            continue
        now = db.now()
        fields = {
            "group_name": source.get("group"),
            "type": source.get("type"),
            "category": source.get("category"),
            "priority": source.get("priority"),
            "url": source.get("url"),
            "site_url": source.get("site_url"),
            "language": source.get("language"),
            "requires_auth": 1 if _bool_value(source.get("requires_auth"), False) else 0,
            "freshness": source.get("freshness"),
            "query_text": source.get("query"),
            "notes": source.get("notes"),
            "extra_json": {"lane": source.get("lane"), "daily_query_enabled": _bool_value(source.get("daily_query_enabled"), True) if source.get("daily_query_enabled") is not None else None},
            "enabled": 1 if _bool_value(source.get("enabled"), True) else 0,
        }
        existing = database.query("SELECT * FROM config_sources WHERE name = %s LIMIT 1", [source["name"]])
        if existing:
            old = existing[0]
            changed = False
            for key, value in fields.items():
                old_value = db.as_json(old.get(key)) if key == "extra_json" else old.get(key)
                if str(old_value or "") != str(value or ""):
                    changed = True
                    break
            if changed:
                database.update("config_sources", {**fields, "updated_at": now}, "id = %s", [old["id"]])
                stats["sources"]["updated"] += 1
            else:
                stats["sources"]["unchanged"] += 1
        else:
            database.insert("config_sources", {"id": db.make_id("src"), "name": source["name"], **fields, "created_at": now, "updated_at": now})
            stats["sources"]["created"] += 1
    return {"ok": True, "force": force, **stats}


def sources_check() -> dict[str, Any]:
    payload = config.read_yaml("sources")
    sources = config._flatten_yaml_sources(payload)  # noqa: SLF001 - this is the source config checker.
    errors: list[str] = []
    warnings: list[str] = []
    valid_types = {"rss", "atom", "fetch_page", "discover_feed_or_fetch", "search_query", "amz123_kx_api"}
    names: set[str] = set()
    urls: dict[str, str] = {}
    type_counts = Counter()
    group_counts = Counter()
    lane_counts = Counter()
    for source in sources:
        name = source.get("name")
        group = source.get("group")
        label = f"{group}/{name or '(no name)'}"
        if not name:
            errors.append(f"{label} 缺少 name")
        elif name in names:
            errors.append(f"重复 name: {name}")
        names.add(name)
        if source.get("type") not in valid_types:
            errors.append(f"{label} type 非法: {source.get('type')}")
        if source.get("type") == "search_query" and not source.get("query"):
            errors.append(f"{label} search_query 缺 query")
        if source.get("type") not in {"search_query", "amz123_kx_api"} and not (source.get("url") or source.get("site_url")):
            errors.append(f"{label} 缺 url/site_url")
        if source.get("url"):
            if source["url"] in urls:
                warnings.append(f"重复 url: {source['url']}（{urls[source['url']]} 与 {label}）")
            urls[source["url"]] = label
        if not source.get("freshness"):
            warnings.append(f"{label} 建议补 freshness")
        type_counts[source.get("type") or "unknown"] += 1
        group_counts[group or "unknown"] += 1
        lane_counts[resolve_source_lane(source)] += 1
    return {
        "ok": not errors,
        "errors": errors,
        "warnings": warnings,
        "summary": {"groups": len(group_counts), "items": len(sources), "types": dict(type_counts), "groupsByName": dict(group_counts), "lanes": dict(lane_counts)},
    }


def keywords_analyze() -> dict[str, Any]:
    rows = config.get_keywords()
    cluster_to_category = {
        "alexa-shopping": "amazon_ai_shopping",
        "amazon-rufus": "amazon_ai_shopping",
        "ai-search-era": "amazon_ai_shopping",
        "listing-optimization": "listing_geo",
        "amazon-geo": "listing_geo",
        "cosmo-algorithm": "listing_geo",
        "traffic-decline": "listing_geo",
        "amazon-ppc": "ppc_acos",
        "ppc-acos": "ppc_acos",
        "product-research": "product_research",
        "product-opportunity": "product_research",
        "keyword-research": "keyword_intent",
        "keyword-intent": "keyword_intent",
        "review-qa": "review_qa",
        "account-compliance": "account_compliance",
        "fba-logistics": "fba_inventory",
        "brand-growth": "brand_growth",
        "ai-tools": "ai_tools",
        "marketplace-policy": "marketplace_policy",
    }
    clusters = Counter(row.get("cluster") or "unknown" for row in rows)
    categories = Counter(cluster_to_category.get(row.get("cluster"), "other") for row in rows)
    p0_by_category = Counter(cluster_to_category.get(row.get("cluster"), "other") for row in rows if row.get("priority") == "P0")
    cognitive_p0 = len([row for row in rows if row.get("priority") == "P0" and any(token in (row.get("keyword") or "") for token in ["是什么", "什么是", "多少算正常", "改名", "renamed"])])
    warnings: list[str] = []
    recommendations: list[str] = []
    total = len(rows)
    if total:
        ai_share = (categories.get("amazon_ai_shopping", 0) + categories.get("listing_geo", 0)) / total
        if ai_share > 0.35:
            warnings.append(f"Amazon AI Shopping + Listing GEO 合计占比 {ai_share * 100:.0f}% > 35%")
            recommendations.append("降低 Alexa/Listing 系关键词占比，或扩充其他分类")
    min_req = {"ppc_acos": 20, "product_research": 20, "keyword_intent": 15, "review_qa": 5, "account_compliance": 5, "fba_inventory": 5, "brand_growth": 5}
    for cat, minimum in min_req.items():
        if categories.get(cat, 0) < minimum:
            warnings.append(f"{cat} 关键词仅 {categories.get(cat, 0)} 个（建议 >= {minimum}）")
            recommendations.append(f"为 {cat} 补充关键词")
    if cognitive_p0 >= 3:
        warnings.append(f"认知型 P0 词有 {cognitive_p0} 个")
        recommendations.append("把“是什么/什么是”类关键词降为 P1/P2")
    return {
        "ok": True,
        "total": total,
        "clusters": dict(clusters.most_common()),
        "businessCategories": dict(categories.most_common()),
        "p0ByCategory": dict(p0_by_category.most_common()),
        "cognitiveP0": cognitive_p0,
        "warnings": warnings,
        "recommendations": recommendations,
    }


def backfill_canonical_sources(*, limit: int | None = None, database: Any | None = None) -> dict[str, Any]:
    database = database or db.Database()
    sql = """
        SELECT id, source_name, source_group, source_url, source_type, title, summary, raw_json, retrieved_at, created_at
        FROM source_items
        WHERE source_url IS NOT NULL AND source_url != ''
        ORDER BY COALESCE(retrieved_at, created_at), created_at
    """
    if limit:
        sql += f" LIMIT {max(1, min(10000, limit))}"
    rows = database.query(sql)
    stats = {"ok": True, "scanned": len(rows), "canonicalInserted": 0, "canonicalUpdated": 0, "duplicatesCollapsed": 0}
    seen_in_run: set[str] = set()
    for row in rows:
        canonical_url = canonicalize_url(row.get("source_url"))
        if not canonical_url:
            continue
        hash_value = canonical_url_hash(canonical_url)
        now = db.now()
        first_seen = row.get("retrieved_at") or row.get("created_at") or now
        lane = resolve_source_lane({"name": row.get("source_name"), "group": row.get("source_group"), "type": row.get("source_type")})
        fingerprint = content_fingerprint(row)
        existing = database.query("SELECT source_item_id FROM source_canonical_items WHERE canonical_url_hash = %s LIMIT 1", [hash_value])
        if existing:
            database.query(
                """
                UPDATE source_canonical_items
                SET first_seen_at = CASE WHEN first_seen_at > %s THEN %s ELSE first_seen_at END,
                    last_seen_at = GREATEST(last_seen_at, %s),
                    seen_count = GREATEST(seen_count, 1),
                    lane = CASE WHEN lane = 'policy' OR %s = 'policy' THEN 'policy' WHEN lane = 'news' OR %s = 'news' THEN 'news' ELSE 'knowledge' END,
                    content_fingerprint = COALESCE(content_fingerprint, %s),
                    updated_at = %s
                WHERE canonical_url_hash = %s
                """,
                [first_seen, first_seen, first_seen, lane, lane, fingerprint, now, hash_value],
            )
            stats["canonicalUpdated"] += 1
            if hash_value in seen_in_run:
                stats["duplicatesCollapsed"] += 1
            seen_in_run.add(hash_value)
            continue
        database.insert("source_canonical_items", {
            "canonical_url_hash": hash_value,
            "canonical_url": canonical_url,
            "source_item_id": row["id"],
            "first_seen_at": first_seen,
            "last_seen_at": first_seen,
            "seen_count": 1,
            "source_count": 1,
            "lane": lane,
            "usage_status": "unused",
            "times_in_prompt": 0,
            "content_fingerprint": fingerprint,
            "last_engine_run_id": None,
            "last_observation_id": None,
            "created_at": now,
            "updated_at": now,
        })
        stats["canonicalInserted"] += 1
        seen_in_run.add(hash_value)
    return stats


def find_articles(*, article_id: str | None = None, slug: str | None = None, status: str | None = None, limit: int = 10, database: Any | None = None) -> list[dict[str, Any]]:
    database = database or db.Database()
    if article_id:
        return database.query("SELECT * FROM articles WHERE id = %s LIMIT 1", [article_id])
    if slug:
        return database.query(f"SELECT * FROM articles WHERE slug = %s ORDER BY created_at DESC LIMIT {max(1, min(50, limit))}", [slug])
    if status:
        return database.query(f"SELECT * FROM articles WHERE status = %s ORDER BY created_at DESC LIMIT {max(1, min(50, limit))}", [status])
    return []


def show_article(*, article_id: str | None = None, slug: str | None = None, status: str | None = None, include_content: bool = False, database: Any | None = None) -> dict[str, Any]:
    database = database or db.Database()
    if not article_id and not slug and not status:
        return {"ok": False, "error": "用法: --id <id> | --slug <slug> | --status <s>，可加 --include-content"}
    articles = find_articles(article_id=article_id, slug=slug, status=status, limit=10, database=database)
    if not articles:
        return {"ok": False, "error": "未找到文章"}
    results = []
    for article in articles:
        latest = database.query("SELECT * FROM article_versions WHERE article_id = %s ORDER BY created_at DESC LIMIT 1", [article["id"]])
        latest_version = latest[0] if latest else None
        versions = database.query("SELECT id, version_label, generation_mode, strategy, status, quality_score, created_at FROM article_versions WHERE article_id = %s ORDER BY created_at", [article["id"]])
        fact_checks = database.query("SELECT overall_risk, publish_readiness, claims_count, high_risk_count, must_fix_count, created_at FROM fact_checks WHERE article_id = %s ORDER BY created_at DESC", [article["id"]])
        scores = database.query("SELECT strategy, overall_score, seo_score, geo_score, fact_score, recommendation, created_at FROM seo_geo_scores WHERE article_id = %s ORDER BY created_at DESC", [article["id"]])
        channel_rows = database.query("SELECT channel, title, status, LENGTH(content_markdown) AS content_length FROM channel_outputs WHERE article_id = %s ORDER BY channel", [article["id"]])
        reviews = database.query("SELECT before_status, after_status, note, dry_run, created_at FROM review_actions WHERE article_id = %s ORDER BY created_at DESC LIMIT 5", [article["id"]])
        classifications = database.query("SELECT content_type, business_category, topic_cluster, confidence, reason, classifier_type, created_at FROM content_classifications WHERE entity_type = 'articles' AND entity_id = %s ORDER BY created_at DESC LIMIT 1", [article["id"]])
        item = {
            "article": {
                "id": article.get("id"),
                "title": article.get("title"),
                "slug": article.get("slug"),
                "status": article.get("status"),
                "contentType": article.get("content_type"),
                "businessCategory": article.get("business_category"),
                "topicCluster": article.get("topic_cluster"),
                "primaryKeyword": article.get("primary_keyword"),
                "qualityScore": article.get("quality_score"),
                "articleQualityScore": article.get("article_quality_score"),
                "seoScore": article.get("seo_score"),
                "geoScore": article.get("geo_score"),
                "publishRecommendation": article.get("publish_recommendation"),
                "factPublishReadiness": article.get("fact_publish_readiness"),
                "currentVersionId": article.get("current_version_id"),
                "createdAt": str(article.get("created_at")),
                "updatedAt": str(article.get("updated_at")),
            },
            "classification": {**classifications[0], "created_at": str(classifications[0].get("created_at"))} if classifications else None,
            "versions": [{**row, "created_at": str(row.get("created_at"))} for row in versions],
            "factChecks": [{**row, "created_at": str(row.get("created_at"))} for row in fact_checks],
            "seoGeoScores": [{**row, "created_at": str(row.get("created_at"))} for row in scores],
            "channels": channel_rows,
            "reviewActions": [{**row, "created_at": str(row.get("created_at"))} for row in reviews],
        }
        if include_content and latest_version:
            markdown = latest_version.get("article_markdown") or ""
            item["content"] = {
                "versionId": latest_version.get("id"),
                "markdownLength": len(markdown),
                "markdownPreview": markdown[:600] + ("\n...(truncated, 全文在 article_versions.article_markdown)" if len(markdown) > 600 else ""),
            }
        results.append(item)
    return {"ok": True, "count": len(results), "results": results}
