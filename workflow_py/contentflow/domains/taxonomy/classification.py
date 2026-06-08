from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import regex as re

from contentflow.core import config, db
from contentflow.llm import model, prompts, validators

RULE_CONFIDENT = 0.85
DEFAULT_AI_BATCH = 15
ENTITIES = {"source_items", "topic_candidates", "articles"}


@dataclass(slots=True)
class Rule:
    pattern: str
    value: str
    confidence: float
    reason: str


CT_RULES = [
    Rule(r"(rufus\s+renamed|alexa\s*for\s*shopping|launch(ed|es)?|introduc(ed|es|ing)|rolls?\s*out|上线|发布|推出|更名|改名|整合)", "product_update", 0.86, "标题含功能上线/更名/整合信号"),
    Rule(r"(how\s+to|guide|checklist|tutorial|step[-\s]by[-\s]step|playbook|方法|如何|教程|攻略|SOP|清单|指南|步骤)", "operation_guide", 0.87, "标题含可执行方法/教程/清单信号"),
    Rule(r"(warning|risk|ban(ned)?|suspend(ed|sion)?|account\s*health|violation|deactivat|封号|违规|风险|警告|申诉|停用|黑科技|避坑)", "risk_warning", 0.88, "标题含违规/封号/风险信号"),
    Rule(r"(policy|fee\s*(change|update)|compliance|regulation|terms\s+of\s+service|新规|政策|费率|合规|条款|规则(变更|更新))", "policy_update", 0.86, "标题含平台政策/费率/合规信号"),
    Rule(r"(report|survey|study|data\s*(show|reveal)|statistics|benchmark|报告|调研|数据显示|白皮书|洞察)", "market_report", 0.82, "标题含报告/调研/数据信号"),
    Rule(r"(trend|future\s+of|why\s+.+\s+is|意味着什么|趋势|解读|变局|展望|影响分析)", "trend_analysis", 0.78, "标题含趋势/解读信号"),
    Rule(r"(case\s*stud(y|ies)|success\s+story|复盘|案例|实战|经验分享)", "case_study", 0.85, "标题含案例/复盘信号"),
    Rule(r"(review(ed|s)?\s+(of|:)|vs\.?\s|versus|alternative(s)?\s+to|comparison|对比|测评|评测|替代)", "tool_review", 0.82, "标题含测评/对比/替代信号"),
]

BC_RULES = [
    Rule(r"(rufus|alexa\s*for\s*shopping|amazon\s*ai\s*shopping|ai\s*overviews?|agentic|ai\s*导购|AI\s*购物)", "amazon_ai_shopping", 0.9, "命中 Amazon AI Shopping 关键词"),
    Rule(r"(listing|a\+\s*content|bullet\s*points?|product\s*(detail\s*)?page|五点|商品页|详情页|图文|语义(结构|优化))", "listing_geo", 0.85, "命中 Listing/商品页关键词"),
    Rule(r"(ppc|acos|cpc|sponsored\s*(products?|brands?|display)|ad(vertising)?\s*(campaign|spend)|广告|竞价|投放)", "ppc_acos", 0.88, "命中广告/PPC 关键词"),
    Rule(r"(keyword|search\s*term|long[-\s]tail|intent|关键词|搜索词|长尾词|意图词|场景词)", "keyword_intent", 0.84, "命中关键词/意图词关键词"),
    Rule(r"(product\s*(research|development|opportunity)|niche|blue\s*ocean|sourcing|选品|蓝海|新品开发|类目机会|未满足需求)", "product_research", 0.86, "命中选品/产品开发关键词"),
    Rule(r"(reviews?\b|q&a|rating|feedback|return\s*(rate|reason)|差评|评论|问答|退货|买家(疑虑|反馈))", "review_qa", 0.82, "命中 Review/Q&A 关键词"),
    Rule(r"(account\s*health|suspend|appeal|ban(ned)?|compliance|violation|封号|申诉|账号(健康|安全)|违规|合规)", "account_compliance", 0.86, "命中账号健康/合规关键词"),
    Rule(r"(fba\b|fulfillment|inventory|warehous|storage\s*fee|logistics|物流|库存|备货|仓储|头程)", "fba_inventory", 0.86, "命中 FBA/物流/库存关键词"),
    Rule(r"(brand\s*(registry|store)|off[-\s]amazon|influencer|deal|prime\s*day|black\s*friday|品牌(备案|旗舰店)|站外|红人|大促|旺季)", "brand_growth", 0.82, "命中品牌/站外/增长关键词"),
    Rule(r"(ai\s*tool|chatgpt|claude|gpt|copilot|erp\b|saas|automation\s*tool|工具(推荐|测评|教程)|AI\s*工具)", "ai_tools", 0.8, "命中 AI/运营工具关键词"),
    Rule(r"(marketplace|seller\s*(news|update)|amazon\s*(announce|update|news)|平台(政策|动态)|卖家(新闻|生态))", "marketplace_policy", 0.72, "命中平台动态关键词"),
]

CLUSTER_RULES = [
    Rule(r"(alexa\s*for\s*shopping|amazon\s*ai\s*shopping)", "alexa_for_shopping_listing", 0.85, "命中 Amazon AI Shopping 主题簇"),
    Rule(r"(rufus)", "rufus_question_data", 0.85, "命中 Rufus 主题簇"),
    Rule(r"(listing.*(语义|semantic|structure|schema)|(语义|semantic).*listing|可抽取|extractab)", "listing_semantic_structure", 0.8, "命中 Listing 语义结构主题簇"),
    Rule(r"((ppc|广告|sponsored).*(intent|意图|转化)|(intent|意图词).*(ppc|广告))", "ppc_intent_keywords", 0.8, "命中 PPC 意图词主题簇"),
    Rule(r"(未满足需求|unmet\s*need|product\s*opportunit|蓝海|选品机会)", "product_opportunity_mining", 0.8, "命中选品机会主题簇"),
    Rule(r"(封号|违规|账号安全|account\s*health|suspend|compliance\s*risk)", "compliance_risk_warning", 0.8, "命中合规风险主题簇"),
]

GROUP_PRIORS = {
    "official_amazon": {"contentType": "policy_update", "businessCategory": "marketplace_policy", "confidence": 0.5, "reason": "official_amazon 来源先验"},
    "official_google": {"contentType": "policy_update", "businessCategory": "marketplace_policy", "confidence": 0.45, "reason": "official_google 来源先验"},
    "community_signals": {"contentType": "qa_discussion", "businessCategory": "review_qa", "confidence": 0.6, "reason": "community_signals 社区来源先验"},
    "seo_geo_ai_search": {"contentType": "trend_analysis", "businessCategory": "listing_geo", "confidence": 0.45, "reason": "seo_geo_ai_search 来源先验"},
    "amazon_seller_tools_blogs": {"contentType": "operation_guide", "businessCategory": "ai_tools", "confidence": 0.4, "reason": "卖家工具博客来源先验"},
    "marketplace_news": {"contentType": "news_flash", "businessCategory": "marketplace_policy", "confidence": 0.45, "reason": "marketplace_news 来源先验"},
}

NEWSY_RE = re.compile(r"(announc|breaking|launch|update[sd]?|news|快讯|宣布|官宣|重磅)", re.I)


def taxonomy() -> dict[str, Any]:
    return config.read_yaml("content_taxonomy")


def cluster_category(cluster: str | None) -> str | None:
    if not cluster:
        return None
    return ((taxonomy().get("topic_clusters") or {}).get(cluster) or {}).get("business_category")


def normalize_classification(payload: dict[str, Any] | None) -> dict[str, Any] | None:
    if not payload:
        return None
    tax = taxonomy()
    content_types = tax.get("content_types") or {}
    business_categories = tax.get("business_categories") or {}
    topic_clusters = tax.get("topic_clusters") or {}
    content_type = payload.get("contentType") or payload.get("content_type")
    business_category = payload.get("businessCategory") or payload.get("business_category")
    topic_cluster = payload.get("topicCluster") or payload.get("topic_cluster") or ""
    if content_type not in content_types:
        content_type = None
    if business_category not in business_categories:
        business_category = None
    if topic_cluster and topic_cluster not in topic_clusters:
        topic_cluster = ""
    if topic_cluster and business_category and cluster_category(topic_cluster) != business_category:
        topic_cluster = ""
    if not content_type and not business_category:
        return None
    return {
        "contentType": content_type,
        "businessCategory": business_category,
        "topicCluster": topic_cluster,
        "confidence": round(float(payload.get("confidence") or 0), 4),
        "reason": str(payload.get("reason") or "分类规则"),
    }


def classify_by_rules(*, title: str = "", summary: str = "", source_group: str | None = None, source_name: str | None = None) -> dict[str, Any] | None:
    text = f"{title or ''} {summary or ''}"
    reasons: list[str] = []
    content_type = None
    content_conf = 0.0
    business_category = None
    business_conf = 0.0
    for rule in CT_RULES:
        if re.search(rule.pattern, text, re.I):
            content_type = rule.value
            content_conf = rule.confidence
            reasons.append(rule.reason)
            break
    for rule in BC_RULES:
        if re.search(rule.pattern, text, re.I):
            business_category = rule.value
            business_conf = rule.confidence
            reasons.append(rule.reason)
            break
    if not content_type and source_group == "community_signals":
        if NEWSY_RE.search(title or ""):
            content_type = "news_flash"
            content_conf = 0.6
            reasons.append("社区来源但标题为新闻信号")
        else:
            content_type = "qa_discussion"
            content_conf = 0.72
            reasons.append("community_signals 社区来源（非新闻标题）")
    prior = GROUP_PRIORS.get(source_group or "")
    if prior:
        if not content_type:
            content_type = prior["contentType"]
            content_conf = prior["confidence"]
            reasons.append(prior["reason"])
        if not business_category:
            business_category = prior["businessCategory"]
            business_conf = min(prior["confidence"], 0.5)
            reasons.append(f"{prior['reason']}（业务分类倾向）")
    if source_group == "official_amazon" and re.search(r"policy|fee|compliance|政策|费率|合规", text, re.I):
        content_type = "policy_update"
        content_conf = max(content_conf, 0.88)
        if not business_category:
            business_category = "marketplace_policy"
            business_conf = 0.8
        reasons.append("official_amazon 官方来源 + 政策费率词")
    if not content_type and not business_category:
        return None
    topic_cluster = ""
    for rule in CLUSTER_RULES:
        if re.search(rule.pattern, text, re.I):
            cat = cluster_category(rule.value)
            if not business_category or business_category == cat:
                topic_cluster = rule.value
                if not business_category:
                    business_category = cat
                    business_conf = 0.75
                break
    confidence = min(content_conf, business_conf) if content_type and business_category else min(content_conf or business_conf, 0.6) * 0.8
    return normalize_classification({
        "contentType": content_type,
        "businessCategory": business_category,
        "topicCluster": topic_cluster,
        "confidence": confidence,
        "reason": f"[rules] {'；'.join(reasons) or '来源先验'}",
    })


def _adapter(entity: str) -> dict[str, Any]:
    if entity == "source_items":
        return {
            "fetch_sql": "SELECT id, title, summary, source_group, source_name FROM source_items {where} ORDER BY created_at DESC LIMIT {limit}",
            "unclassified": "WHERE content_type IS NULL OR business_category IS NULL",
            "to_input": lambda row: {"title": row.get("title") or "", "summary": row.get("summary") or "", "sourceGroup": row.get("source_group"), "sourceName": row.get("source_name")},
            "write": lambda database, row_id, c, now: database.update("source_items", {
                "content_type": c.get("contentType"),
                "business_category": c.get("businessCategory"),
                "topic_cluster": c.get("topicCluster") or None,
                "classification_confidence": c.get("confidence"),
                "classification_reason": c.get("reason"),
            }, "id = %s", [row_id]),
        }
    if entity == "topic_candidates":
        return {
            "fetch_sql": "SELECT id, topic, content_angle, business_angle, category, primary_keyword FROM topic_candidates {where} ORDER BY created_at DESC LIMIT {limit}",
            "unclassified": "WHERE content_type IS NULL OR business_category IS NULL",
            "to_input": lambda row: {
                "title": row.get("topic") or "",
                "summary": "；".join([x for x in [row.get("content_angle"), row.get("business_angle")] if x]),
                "sourceGroup": None,
                "sourceName": None,
                "keywords": [row.get("primary_keyword")] if row.get("primary_keyword") else [],
            },
            "write": lambda database, row_id, c, now: database.update("topic_candidates", {
                "content_type": c.get("contentType"),
                "business_category": c.get("businessCategory"),
                "topic_cluster": c.get("topicCluster") or None,
                "classification_confidence": c.get("confidence"),
                "classification_reason": c.get("reason"),
                "updated_at": now,
            }, "id = %s", [row_id]),
        }
    if entity == "articles":
        return {
            "fetch_sql": "SELECT id, title, primary_keyword, secondary_keywords_json FROM articles {where} ORDER BY created_at DESC LIMIT {limit}",
            "unclassified": "WHERE content_type IS NULL OR business_category IS NULL",
            "to_input": lambda row: {
                "title": row.get("title") or "",
                "summary": "",
                "sourceGroup": None,
                "sourceName": None,
                "keywords": [kw for kw in [row.get("primary_keyword"), *(db.as_json(row.get("secondary_keywords_json")) or [])] if kw][:6],
            },
            "write": _write_article_classification,
        }
    raise ValueError(f"未知实体: {entity}")


def _write_article_classification(database: Any, row_id: str, c: dict[str, Any], now: str) -> None:
    database.update("articles", {
        "content_type": c.get("contentType"),
        "business_category": c.get("businessCategory"),
        "topic_cluster": c.get("topicCluster") or None,
        "updated_at": now,
    }, "id = %s", [row_id])
    database.query(
        "UPDATE article_versions SET content_type = %s, business_category = %s, topic_cluster = %s, updated_at = %s WHERE article_id = %s",
        [c.get("contentType"), c.get("businessCategory"), c.get("topicCluster") or None, now, row_id],
    )


def record_classification(*, entity_type: str, entity_id: str, classification: dict[str, Any], classifier_type: str, model_run_id: str | None = None, raw: Any | None = None, database: Any | None = None) -> None:
    database = database or db.Database()
    database.insert("content_classifications", {
        "id": db.make_id("cls"),
        "entity_type": entity_type,
        "entity_id": entity_id,
        "content_type": classification.get("contentType"),
        "business_category": classification.get("businessCategory"),
        "topic_cluster": classification.get("topicCluster") or None,
        "confidence": classification.get("confidence"),
        "reason": classification.get("reason"),
        "classifier_type": classifier_type,
        "model_run_id": model_run_id,
        "raw_json": raw,
        "created_at": db.now(),
    })


def ai_classify_batch(*, items: list[dict[str, Any]], engine_run_id: str | None, database: Any, call_agent=model.call_agent) -> dict[str, Any]:
    result = call_agent(
        task_type="content_classification",
        prompt=prompts.classification_prompt(items=items),
        session_key=f"agent:main:classify-{db.make_id('batch')}",
        engine_run_id=engine_run_id,
        db_client=database,
    )
    if not result.get("ok"):
        return {"ok": False, "error": result.get("error"), "modelRunId": result.get("modelRunId"), "byIndex": {}}
    arr = result["data"] if isinstance(result["data"], list) else [result["data"]]
    by_index: dict[int, dict[str, Any]] = {}
    for item in arr:
        if not isinstance(item, dict):
            continue
        normalized = normalize_classification(item)
        if not normalized:
            continue
        validation = validators.validate_content_classification_data({**normalized, "index": item.get("index", 1)})
        if validation.ok:
            by_index[int(item.get("index") or 0)] = normalized
    return {"ok": True, "modelRunId": result.get("modelRunId"), "byIndex": by_index}


def classify_rows(*, entity: str, rows: list[dict[str, Any]], engine_run_id: str | None = None, ai_batch: int = DEFAULT_AI_BATCH, max_ai_calls: int | None = None, no_ai: bool = False, database: Any | None = None, call_agent=model.call_agent) -> dict[str, Any]:
    database = database or db.Database()
    adapter = _adapter(entity)
    now = db.now()
    stats = {"classified": 0, "byRules": 0, "byAi": 0, "failed": 0, "lowConfidence": []}
    need_ai: list[dict[str, Any]] = []
    for row in rows:
        item = adapter["to_input"](row)
        rule = classify_by_rules(title=item.get("title") or "", summary=item.get("summary") or "", source_group=item.get("sourceGroup"), source_name=item.get("sourceName"))
        if rule and rule.get("contentType") and rule.get("businessCategory") and float(rule.get("confidence") or 0) >= RULE_CONFIDENT:
            adapter["write"](database, row["id"], rule, now)
            record_classification(entity_type=entity, entity_id=row["id"], classification=rule, classifier_type="rules", database=database)
            stats["classified"] += 1
            stats["byRules"] += 1
        else:
            need_ai.append({"row": row, "input": item, "rule": rule})
    max_calls = max_ai_calls if max_ai_calls is not None else 10**9
    cursor = 0
    ai_calls = 0
    while cursor < len(need_ai) and not no_ai and ai_calls < max_calls:
        batch = need_ai[cursor:cursor + max(1, min(30, ai_batch))]
        cursor += len(batch)
        ai_calls += 1
        items = []
        for index, item in enumerate(batch, start=1):
            rule = item["rule"]
            payload = {"index": index, **item["input"]}
            if rule:
                payload["ruleHint"] = f"{rule.get('contentType') or '-'} / {rule.get('businessCategory') or '-'}（conf {rule.get('confidence')}）"
            items.append(payload)
        res = ai_classify_batch(items=items, engine_run_id=engine_run_id, database=database, call_agent=call_agent)
        for index, item in enumerate(batch, start=1):
            final = res.get("byIndex", {}).get(index) or item["rule"]
            if not final or not final.get("contentType"):
                stats["failed"] += 1
                continue
            if not res.get("byIndex", {}).get(index) and final.get("reason"):
                final["reason"] = f"{final['reason']}（AI 兜底失败，沿用规则低置信结果）"
            adapter["write"](database, item["row"]["id"], final, db.now())
            record_classification(entity_type=entity, entity_id=item["row"]["id"], classification=final, classifier_type="openclaw" if res.get("byIndex", {}).get(index) else "rules", model_run_id=res.get("modelRunId") if res.get("byIndex", {}).get(index) else None, raw=final if res.get("byIndex", {}).get(index) else None, database=database)
            stats["classified"] += 1
            stats["byAi" if res.get("byIndex", {}).get(index) else "byRules"] += 1
            if float(final.get("confidence") or 0) < 0.7:
                stats["lowConfidence"].append({"id": item["row"]["id"], "title": (item["input"].get("title") or "")[:60], "confidence": final.get("confidence"), "reason": (final.get("reason") or "")[:120]})
    for item in need_ai[cursor:]:
        rule = item["rule"]
        if rule and rule.get("contentType"):
            adapter["write"](database, item["row"]["id"], rule, db.now())
            record_classification(entity_type=entity, entity_id=item["row"]["id"], classification=rule, classifier_type="rules", database=database)
            stats["classified"] += 1
            stats["byRules"] += 1
            stats["lowConfidence"].append({"id": item["row"]["id"], "title": (item["input"].get("title") or "")[:60], "confidence": rule.get("confidence"), "reason": "超出 AI 预算，规则低置信"})
        else:
            stats["failed"] += 1
    return stats


def classify_entity(*, entity: str, limit: int = 100, force: bool = False, engine_run_id: str | None = None, ai_batch: int = DEFAULT_AI_BATCH, max_ai_calls: int | None = None, no_ai: bool = False, database: Any | None = None, call_agent=model.call_agent) -> dict[str, Any]:
    if entity not in ENTITIES:
        raise ValueError(f"entity 非法: {entity}")
    database = database or db.Database()
    adapter = _adapter(entity)
    where = "" if force else adapter["unclassified"]
    rows = database.query(adapter["fetch_sql"].format(where=where, limit=max(1, min(2000, limit))))
    if not rows:
        return {"entity": entity, "total": 0, "classified": 0, "byRules": 0, "byAi": 0, "failed": 0, "lowConfidence": []}
    stats = classify_rows(entity=entity, rows=rows, engine_run_id=engine_run_id, ai_batch=ai_batch, max_ai_calls=max_ai_calls, no_ai=no_ai, database=database, call_agent=call_agent)
    return {"entity": entity, "total": len(rows), **stats}


def run_classify(*, entity: str | None = None, all_entities: bool = False, limit: int = 100, force: bool = False, no_ai: bool = False, ai_batch: int = DEFAULT_AI_BATCH, max_ai_calls: int | None = None, engine_run_id: str | None = None, database: Any | None = None, call_agent=model.call_agent) -> dict[str, Any]:
    entities = sorted(ENTITIES) if all_entities else ([entity] if entity else [])
    if not entities:
        return {"ok": False, "error": "用法: --entity <source_items|topic_candidates|articles> 或 --all"}
    database = database or db.Database()
    results = [
        classify_entity(entity=item, limit=limit, force=force, engine_run_id=engine_run_id, ai_batch=ai_batch, max_ai_calls=max_ai_calls, no_ai=no_ai, database=database, call_agent=call_agent)
        for item in entities
    ]
    totals = {
        "total": sum(r["total"] for r in results),
        "classified": sum(r["classified"] for r in results),
        "byRules": sum(r["byRules"] for r in results),
        "byAi": sum(r["byAi"] for r in results),
        "failed": sum(r["failed"] for r in results),
    }
    return {"ok": True, "totals": totals, "results": [{**r, "lowConfidence": r["lowConfidence"][:10]} for r in results]}
