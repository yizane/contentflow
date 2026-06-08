from __future__ import annotations

import json
from typing import Any
from urllib.parse import urlsplit

import regex

AMAZON_HOST_RE = regex.compile(r"(^|\.)((aboutamazon|sellercentral|sell|advertising|developer|business)\.amazon\.com|amazon\.[a-z.]+)$", regex.I)
AMAZON_ECOMMERCE_RE = regex.compile(r"\bamazon\b|亚马逊|seller\s*central|vendor\s*central|amazon\s*(seller|ads?|advertising|marketplace)|fba\b|fbm\b|asin\b|buy\s*box|prime\s*day|sponsored\s*(products?|brands?|display)|卖家平台|卖家中心|亚马逊(美国站|卖家|广告|平台|店铺|站内)|购物车按钮", regex.I)
NON_AMAZON_ECOMMERCE_RE = regex.compile(r"电商|跨境|marketplace|e-?commerce|retail\s*media|零售媒体|wildberries|ozon|yandex\s*market|magnit|shopee|lazada|temu|shein|tiktok\s*shop|walmart|ebay|shopify|速卖通|阿里国际站", regex.I)


def canonical_url(url: str | None) -> str:
    return str(url or "").strip().rstrip("/")


def candidate_source_urls(candidate: dict[str, Any]) -> list[str]:
    urls = candidate.get("sourceUrls", candidate.get("source_urls_json", []))
    if isinstance(urls, str):
        try:
            urls = json.loads(urls)
        except json.JSONDecodeError:
            return []
    if not isinstance(urls, list):
        return []
    return [canonical_url(url) for url in urls if canonical_url(url)]


def lookup_source(source_by_url: dict[str, dict[str, Any]], url: str) -> dict[str, Any] | None:
    key = canonical_url(url)
    return source_by_url.get(url) or source_by_url.get(key) or source_by_url.get(f"{key}/")


def source_text(source: dict[str, Any] | None) -> str:
    if not source:
        return ""
    return "\n".join(str(source.get(key) or "") for key in ["source_group", "source_name", "source_url", "title", "summary"] if source.get(key))


def assess_source(source: dict[str, Any] | None) -> dict[str, Any]:
    if not source:
        return {"isAmazonEcommerce": False, "isNonAmazonEcommerce": False, "reason": "source_url 未匹配到 source_items"}
    url = source.get("source_url") or source.get("url") or ""
    try:
        host = urlsplit(url).hostname or ""
    except Exception:
        host = ""
    text = source_text(source)
    is_amazon = source.get("source_group") == "official_amazon" or bool(AMAZON_HOST_RE.search(host)) or bool(AMAZON_ECOMMERCE_RE.search(text))
    is_non_amazon = not is_amazon and bool(NON_AMAZON_ECOMMERCE_RE.search(text))
    return {
        "isAmazonEcommerce": is_amazon,
        "isNonAmazonEcommerce": is_non_amazon,
        "reason": "命中亚马逊电商行业信号" if is_amazon else "命中非亚马逊电商/平台信号" if is_non_amazon else "未命中亚马逊电商行业信号",
    }


def assess_candidate_source_relevance(candidate: dict[str, Any], source_by_url: dict[str, dict[str, Any]]) -> dict[str, Any]:
    urls = candidate_source_urls(candidate)
    sources = []
    for url in urls:
        source = lookup_source(source_by_url, url)
        sources.append({"url": url, "source": source, **assess_source(source)})
    matched_count = len([row for row in sources if row["source"]])
    missing_count = len(sources) - matched_count
    amazon_count = len([row for row in sources if row["isAmazonEcommerce"]])
    non_amazon_count = len([row for row in sources if row["isNonAmazonEcommerce"]])
    return {
        "urls": urls,
        "sources": sources,
        "matchedCount": matched_count,
        "missingCount": missing_count,
        "amazonCount": amazon_count,
        "nonAmazonEcommerceCount": non_amazon_count,
        "hasAmazonEcommerceSource": amazon_count > 0,
        "hasNonAmazonEcommerceSource": non_amazon_count > 0,
        "hasOnlyAmazonEcommerceSources": len(urls) > 0 and missing_count == 0 and amazon_count == len(urls),
    }


def priority_for_score(score: int) -> str:
    if score >= 85:
        return "P0"
    if score >= 70:
        return "P1"
    return "P2"


def apply_candidate_source_score_guard(candidate: dict[str, Any], relevance: dict[str, Any], *, cap: int = 59) -> dict[str, Any]:
    original_score = round(float(candidate.get("score") or 0))
    guarded = {**candidate, "originalScore": original_score, "rejected": False, "reason": ""}
    if not relevance["hasOnlyAmazonEcommerceSources"]:
        score = min(original_score, cap)
        guarded["score"] = score
        if candidate.get("contentValueScore") is not None:
            guarded["contentValueScore"] = min(round(float(candidate.get("contentValueScore") or 0)), cap)
        guarded["priority"] = priority_for_score(score)
        guarded["rejected"] = True
        guarded["reason"] = (
            "候选未引用任何 sourceUrl，无法证明由亚马逊电商行业素材支撑"
            if not relevance["urls"]
            else f"候选引用了非亚马逊电商行业素材或未匹配素材（Amazon {relevance['amazonCount']}/{len(relevance['urls'])}，missing {relevance['missingCount']}）"
        )
    return guarded


def build_source_url_map(source_items: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for item in source_items or []:
        url = canonical_url(item.get("source_url"))
        if url:
            out[url] = item
    return out


def source_ids_for_candidate(candidate: dict[str, Any], source_by_url: dict[str, dict[str, Any]]) -> list[str]:
    ids: list[str] = []
    for url in candidate_source_urls(candidate):
        source = lookup_source(source_by_url, url)
        if source and source.get("id"):
            ids.append(source["id"])
    return ids

