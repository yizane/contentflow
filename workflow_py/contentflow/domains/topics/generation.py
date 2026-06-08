from __future__ import annotations

import os
import time
from datetime import timedelta
from typing import Any

from contentflow.core import config, db, trace
from contentflow.flow import runtime
from contentflow.llm import model, prompts, validators
from contentflow.domains.sources.identity import canonical_url_hash, normalized_topic
from contentflow.domains.sources.ingest import canonical_source_ids_for_urls
from contentflow.domains.sources.lanes import source_priority_score
from contentflow.domains.topics.dedupe import decide_topic_dedupe, duplicate_defer_until
from contentflow.domains.topics import source_relevance


def source_scope_policy(policy: dict[str, Any]) -> dict[str, Any]:
    return {
        "news_limit": 25,
        "news_window_hours": 72,
        "policy_limit": 15,
        "policy_window_hours": 168,
        "knowledge_limit": 40,
        "knowledge_pool_limit": 120,
        "knowledge_soft_expire_days": 90,
        **(policy.get("source_scope") or {}),
    }


def mysql_hours_ago(hours: int) -> str:
    now = runtime.engine_now_date(os.environ.get("ENGINE_NOW"))
    return runtime.mysql_datetime_from_date(now - timedelta(hours=hours))


def parse_json_array(value: Any) -> list[Any]:
    parsed = db.as_json(value)
    return parsed if isinstance(parsed, list) else []


def source_config_by_name(database: Any) -> dict[str, dict[str, Any]]:
    return {source.get("name"): source for source in config.get_source_items(db_client=database)}


def update_knowledge_prompt_counts(database: Any, items: list[dict[str, Any]]) -> None:
    hashes = {item.get("canonical_url_hash") for item in items if item.get("lane") == "knowledge" and item.get("canonical_url_hash")}
    for url_hash in hashes:
        database.query("UPDATE source_canonical_items SET times_in_prompt = times_in_prompt + 1, updated_at = %s WHERE canonical_url_hash = %s", [db.now(), url_hash])


def select_topic_source_items(*, engine_run_id: str | None, policy: dict[str, Any], database: Any | None = None) -> dict[str, Any]:
    database = database or db.Database()
    scope = source_scope_policy(policy)
    fields = """
      si.id, si.source_group, si.source_name, si.source_url, si.title, si.summary, si.content_text,
      si.content_type, si.business_category,
      sci.canonical_url_hash, sci.lane, sci.first_seen_at, sci.usage_status, sci.times_in_prompt,
      COUNT(so.id) AS observation_count,
      JSON_ARRAYAGG(so.id) AS observation_ids_json
    """
    group_by = """
      si.id, si.source_group, si.source_name, si.source_url, si.title, si.summary, si.content_text,
      si.content_type, si.business_category,
      sci.canonical_url_hash, sci.lane, sci.first_seen_at, sci.usage_status, sci.times_in_prompt
    """
    news: list[dict[str, Any]] = []
    policy_rows: list[dict[str, Any]] = []
    if engine_run_id:
        news = database.query(
            f"""
            SELECT {fields}
            FROM source_observations so
            JOIN source_canonical_items sci ON sci.canonical_url_hash = so.canonical_url_hash
            JOIN source_items si ON si.id = sci.source_item_id
            WHERE so.engine_run_id = %s AND sci.lane = 'news' AND sci.first_seen_at >= %s
            GROUP BY {group_by}
            ORDER BY MAX(so.created_at) DESC
            LIMIT {max(1, min(200, int(scope["news_limit"])))}
            """,
            [engine_run_id, mysql_hours_ago(int(scope["news_window_hours"]))],
        )
        policy_rows = database.query(
            f"""
            SELECT {fields}
            FROM source_observations so
            JOIN source_canonical_items sci ON sci.canonical_url_hash = so.canonical_url_hash
            JOIN source_items si ON si.id = sci.source_item_id
            WHERE so.engine_run_id = %s AND sci.lane = 'policy'
              AND (sci.first_seen_at >= %s OR sci.reactivated_at >= %s)
            GROUP BY {group_by}
            ORDER BY GREATEST(sci.first_seen_at, COALESCE(sci.reactivated_at, sci.first_seen_at)) DESC
            LIMIT {max(1, min(200, int(scope["policy_limit"])))}
            """,
            [engine_run_id, mysql_hours_ago(int(scope["policy_window_hours"])), mysql_hours_ago(int(scope["policy_window_hours"]))],
        )

    pool_limit = max(int(scope["knowledge_limit"]), min(500, int(scope["knowledge_pool_limit"])))
    knowledge_pool = database.query(
        f"""
        SELECT si.id, si.source_group, si.source_name, si.source_url, si.title, si.summary, si.content_text,
               si.content_type, si.business_category,
               sci.canonical_url_hash, sci.lane, sci.first_seen_at, sci.usage_status, sci.times_in_prompt,
               0 AS observation_count,
               JSON_ARRAY() AS observation_ids_json
        FROM source_canonical_items sci
        JOIN source_items si ON si.id = sci.source_item_id
        WHERE sci.lane = 'knowledge' AND sci.usage_status = 'unused'
        ORDER BY sci.times_in_prompt ASC, sci.first_seen_at DESC
        LIMIT {pool_limit}
        """
    )
    config_by_name = source_config_by_name(database)
    now = runtime.engine_now_date(os.environ.get("ENGINE_NOW"))
    scored_knowledge = []
    for row in knowledge_pool:
        src = config_by_name.get(row.get("source_name")) or {}
        first_seen = row.get("first_seen_at")
        age_days = 0
        if first_seen:
            try:
                age_days = max(0, (now - runtime.engine_now_date(str(first_seen))).total_seconds() / 86400)
            except Exception:
                age_days = 0
        old_penalty = 20 if age_days > int(scope["knowledge_soft_expire_days"]) else 0
        score = source_priority_score(src) - min(15, int(age_days // 14)) - old_penalty - (int(row.get("times_in_prompt") or 0) * 5)
        scored_knowledge.append({**row, "priority_rank": source_priority_score(src), "lane_sort_score": score})
    knowledge = sorted(scored_knowledge, key=lambda row: (-row["lane_sort_score"], int(row.get("times_in_prompt") or 0)))[:max(1, min(200, int(scope["knowledge_limit"])))]

    combined = [*news, *policy_rows, *knowledge]
    deduped = []
    seen: set[str] = set()
    for row in combined:
        if row.get("id") in seen:
            continue
        seen.add(row.get("id"))
        deduped.append(row)
    update_knowledge_prompt_counts(database, deduped)
    return {"items": deduped, "summary": {"news": len(news), "policy": len(policy_rows), "knowledge": len(knowledge), "total": len(deduped), "scope": scope}}


def insert_topic_dedupe_record(database: Any, *, engine_run_id: str | None, topic_candidate_id: str | None = None, candidate: dict[str, Any], decision: dict[str, Any], record_decision: str) -> None:
    database.insert("topic_dedupe_records", {
        "id": db.make_id("tdedupe"),
        "engine_run_id": engine_run_id,
        "topic_candidate_id": topic_candidate_id,
        "duplicate_of_topic_candidate_id": decision.get("duplicateOfTopicCandidateId"),
        "candidate_topic": str(candidate.get("topic") or "")[:510],
        "normalized_topic": normalized_topic(candidate.get("topic") or "")[:510],
        "primary_keyword": candidate.get("primaryKeyword"),
        "decision": record_decision,
        "similarity": round(float(decision["similarity"]), 4) if decision.get("similarity") is not None else None,
        "reason": decision.get("reason"),
        "raw_candidate_json": candidate,
        "created_at": db.now(),
    })


def insert_topic_signal(database: Any, *, engine_run_id: str | None, observation_id: str | None, source_item_id: str | None, topic_candidate_id: str | None, topic: str | None, status: str, score: float | int | None = None, reason: str | None = None, raw: Any = None) -> None:
    database.insert("topic_signals", {
        "id": db.make_id("tsig"),
        "engine_run_id": engine_run_id,
        "source_observation_id": observation_id,
        "source_item_id": source_item_id,
        "topic_candidate_id": topic_candidate_id,
        "signal_topic": str(topic)[:510] if topic else None,
        "status": status,
        "score": round(float(score)) if score is not None else None,
        "reason": reason,
        "raw_json": raw,
        "created_at": db.now(),
    })


def write_unselected_observation_signals(database: Any, *, engine_run_id: str | None, all_observation_ids: set[str], matched_observation_ids: set[str], source_item_id_by_observation_id: dict[str, str]) -> int:
    count = 0
    for observation_id in all_observation_ids:
        if observation_id in matched_observation_ids:
            continue
        insert_topic_signal(
            database,
            engine_run_id=engine_run_id,
            observation_id=observation_id,
            source_item_id=source_item_id_by_observation_id.get(observation_id),
            topic_candidate_id=None,
            topic=None,
            status="not_selected_by_model",
            reason="source observation was included in prompt scope but no candidate cited it",
        )
        count += 1
    return count


def _days_ago(days: int) -> str:
    now = runtime.engine_now_date(os.environ.get("ENGINE_NOW"))
    return runtime.mysql_datetime_from_date(now - timedelta(days=days))


def _classification_from_candidate(candidate: dict[str, Any]) -> dict[str, Any] | None:
    if not candidate.get("contentType") or not candidate.get("businessCategory"):
        return None
    return {
        "contentType": candidate.get("contentType"),
        "businessCategory": candidate.get("businessCategory"),
        "topicCluster": candidate.get("topicCluster") or None,
        "confidence": 0.9,
        "reason": "[topic_generation] 主题生成时由 AI 判定（继承/修正 source 分类）",
    }


def generate_topics(*, engine_run_id: str | None, database: Any | None = None, call_agent=model.call_agent) -> dict[str, Any]:
    database = database or db.Database()
    policy = config.read_yaml("production_policy")
    source_scope = "global_recent"
    source_scope_summary = None
    if engine_run_id:
        scoped = select_topic_source_items(engine_run_id=engine_run_id, policy=policy, database=database)
        items = scoped["items"]
        source_scope = "engine_run_lanes"
        source_scope_summary = scoped["summary"]
    else:
        items = []
    if not items:
        items = database.query(
            """
            SELECT id, source_group, source_name, source_url, title, summary, content_text, content_type, business_category,
                   NULL AS canonical_url_hash, NULL AS lane, 0 AS observation_count, JSON_ARRAY() AS observation_ids_json
            FROM source_items ORDER BY created_at DESC LIMIT 60
            """
        )
        source_scope = "global_recent_fallback"
    if not items:
        return {"ok": False, "error": "没有 source_items，请先 collect:sources"}

    source_ids_by_url: dict[str, list[str]] = {}
    source_ids_by_hash: dict[str, list[str]] = {}
    all_observation_ids: set[str] = set()
    matched_observation_ids: set[str] = set()
    source_item_id_by_observation_id: dict[str, str] = {}
    source_by_url = source_relevance.build_source_url_map(items)
    for item in items:
        if item.get("source_url"):
            source_ids_by_url.setdefault(item["source_url"], []).append(item["id"])
            source_ids_by_hash.setdefault(canonical_url_hash(item["source_url"]), []).append(item["id"])
        for obs_id in parse_json_array(item.get("observation_ids_json")):
            all_observation_ids.add(obs_id)
            source_item_id_by_observation_id[obs_id] = item["id"]

    recent = database.query("SELECT title FROM articles WHERE status != 'archived' AND created_at >= %s ORDER BY created_at DESC LIMIT 20", [_days_ago(30)])
    prompt = prompts.topic_generation_prompt(
        source_items=items,
        keywords_csv=config.get_keywords_csv(db_client=database),
        recent_topics=[row["title"] for row in recent],
    )
    agent_result = call_agent(
        task_type="topic_generation",
        prompt=prompt,
        session_key=f"agent:main:topicgen-{int(time.time() * 1000) % 1_000_000}",
        engine_run_id=engine_run_id,
        db_client=database,
    )
    if not agent_result.get("ok"):
        return {"ok": False, "error": agent_result.get("error")}

    validation = validators.validate_topic_candidates_data(agent_result["data"], config.get_keyword_set(db_client=database))
    if not validation.ok:
        return {"ok": False, "error": "; ".join(validation.issues[:5])}

    dedupe_policy = policy.get("dedupe") or {}
    window_days = int(dedupe_policy.get("normalized_topic_window_days") or 30)
    recent_topics = [
        *database.query("SELECT id, title AS topic, NULL AS normalized_topic FROM articles WHERE created_at >= %s", [_days_ago(window_days)]),
        *database.query("SELECT id, topic, normalized_topic FROM topic_candidates WHERE created_at >= %s AND status != 'rejected'", [_days_ago(window_days)]),
    ]
    now = db.now()
    inserted = 0
    shadow_duplicates = 0
    deferred_duplicates = 0
    deferred_keywords = 0
    source_rejected = 0
    unique_inserted = 0
    topic_signals = {"mergedIntoCandidate": 0, "notSelectedByModel": 0, "blockedDuplicate": 0}

    for raw_candidate in agent_result["data"]["candidates"]:
        relevance = source_relevance.assess_candidate_source_relevance(raw_candidate, source_by_url)
        candidate = source_relevance.apply_candidate_source_score_guard(raw_candidate, relevance)
        rejected_by_source = bool(candidate.get("rejected"))
        norm = normalized_topic(candidate.get("topic"))
        exact_existing = database.query("SELECT id, topic, normalized_topic FROM topic_candidates WHERE normalized_topic = %s LIMIT 1", [norm])
        kw_count_rows = database.query("SELECT COUNT(*) c FROM articles WHERE primary_keyword = %s AND created_at >= %s", [candidate.get("primaryKeyword"), _days_ago(int(dedupe_policy.get("primary_keyword_window_days") or 14))])
        kw_count = int((kw_count_rows[0] if kw_count_rows else {}).get("c") or 0)
        decision = {"decision": "source_rejected", "reason": candidate.get("reason"), "similarity": None} if rejected_by_source else decide_topic_dedupe(
            candidate,
            [*exact_existing, *recent_topics],
            policy,
            {"keywordArticleCount": kw_count, "keywordLimit": dedupe_policy.get("max_articles_per_primary_keyword_in_window", 2)},
        )
        source_urls = candidate.get("sourceUrls") if isinstance(candidate.get("sourceUrls"), list) else []
        canonical_matches = canonical_source_ids_for_urls(source_urls, database=database)
        source_item_ids = sorted(set(
            source_id
            for url in source_urls
            for source_id in [
                *(source_ids_by_url.get(url) or []),
                *(source_ids_by_hash.get(canonical_url_hash(url)) or []),
                *([canonical_matches[url]] if url in canonical_matches else []),
            ]
        ))
        candidate_observation_ids: list[str] = []
        for item in items:
            if item["id"] in source_item_ids:
                candidate_observation_ids.extend(parse_json_array(item.get("observation_ids_json")))

        if not rejected_by_source and decision["decision"] == "shadow_duplicate":
            insert_topic_dedupe_record(database, engine_run_id=engine_run_id, candidate=candidate, decision=decision, record_decision="shadow_duplicate")
            shadow_duplicates += 1
            for obs_id in set(candidate_observation_ids):
                matched_observation_ids.add(obs_id)
                insert_topic_signal(database, engine_run_id=engine_run_id, observation_id=obs_id, source_item_id=source_item_id_by_observation_id.get(obs_id), topic_candidate_id=None, topic=candidate.get("topic"), status="blocked_duplicate", score=candidate.get("score"), reason=decision.get("reason"), raw=candidate)
                topic_signals["blockedDuplicate"] += 1
            continue

        status = "rejected" if rejected_by_source else "candidate"
        selection_status = "rejected_source_relevance" if rejected_by_source else None
        selection_skip_reason = candidate.get("reason") if rejected_by_source else None
        deferred_until = None
        record_decision = "source_rejected" if rejected_by_source else "unique_inserted"
        if rejected_by_source:
            source_rejected += 1
        elif decision["decision"] == "deferred_duplicate":
            status = "deferred"
            selection_status = "skipped_duplicate"
            selection_skip_reason = decision.get("reason")
            deferred_until = duplicate_defer_until(runtime.engine_now_date(os.environ.get("ENGINE_NOW")), int((policy.get("topic_dedupe") or {}).get("duplicate_defer_days") or 14))
            record_decision = "deferred_duplicate"
            deferred_duplicates += 1
        elif decision["decision"] == "deferred_keyword":
            status = "deferred"
            selection_status = "skipped_recent_keyword"
            selection_skip_reason = decision.get("reason")
            deferred_until = duplicate_defer_until(runtime.engine_now_date(os.environ.get("ENGINE_NOW")), int((policy.get("topic_dedupe") or {}).get("duplicate_defer_days") or 14))
            record_decision = "deferred_keyword"
            deferred_keywords += 1
        else:
            unique_inserted += 1

        topic_id = db.make_id("topiccand")
        classification = _classification_from_candidate(candidate)
        database.insert("topic_candidates", {
            "id": topic_id,
            "engine_run_id": engine_run_id,
            "topic": str(candidate.get("topic") or "")[:510],
            "normalized_topic": norm[:510],
            "primary_keyword": candidate.get("primaryKeyword"),
            "secondary_keywords_json": candidate.get("secondaryKeywords") or [],
            "category": candidate.get("category"),
            "content_angle": candidate.get("contentAngle"),
            "business_angle": candidate.get("businessAngle"),
            "source_item_ids_json": source_item_ids,
            "source_urls_json": source_urls,
            "score": round(float(candidate.get("score") or 0)),
            "raw_score": round(float(candidate.get("score") or 0)),
            "content_value_score": round(float(candidate["contentValueScore"])) if candidate.get("contentValueScore") is not None else None,
            "value_breakdown_json": {
                "sellerPainValue": candidate.get("sellerPainValue"),
                "actionability": candidate.get("actionability"),
                "informationGain": candidate.get("informationGain"),
                "businessFit": candidate.get("businessFit"),
                "nonRepetition": candidate.get("nonRepetition"),
                "sourceSupport": candidate.get("sourceSupport"),
            } if candidate.get("contentValueScore") is not None else None,
            "priority": candidate.get("priority"),
            "status": status,
            "reject_reason": f"[source_relevance] {candidate.get('reason')}" if rejected_by_source else candidate.get("rejectRisk"),
            "selection_status": selection_status,
            "selection_skip_reason": selection_skip_reason,
            "deferred_until": deferred_until,
            "content_type": classification.get("contentType") if classification else None,
            "business_category": classification.get("businessCategory") if classification else None,
            "topic_cluster": classification.get("topicCluster") if classification else None,
            "classification_confidence": classification.get("confidence") if classification else None,
            "classification_reason": classification.get("reason") if classification else None,
            "created_at": now,
            "updated_at": now,
        })
        if classification:
            database.insert("content_classifications", {
                "id": db.make_id("cls"),
                "entity_type": "topic_candidates",
                "entity_id": topic_id,
                "content_type": classification.get("contentType"),
                "business_category": classification.get("businessCategory"),
                "topic_cluster": classification.get("topicCluster"),
                "confidence": classification.get("confidence"),
                "reason": classification.get("reason"),
                "classifier_type": "topic_generation",
                "model_run_id": None,
                "raw_json": None,
                "created_at": now,
            })
        insert_topic_dedupe_record(database, engine_run_id=engine_run_id, topic_candidate_id=topic_id, candidate=candidate, decision=decision, record_decision=record_decision)
        for obs_id in set(candidate_observation_ids):
            matched_observation_ids.add(obs_id)
            insert_topic_signal(
                database,
                engine_run_id=engine_run_id,
                observation_id=obs_id,
                source_item_id=source_item_id_by_observation_id.get(obs_id),
                topic_candidate_id=topic_id,
                topic=candidate.get("topic"),
                status="blocked_source_relevance" if rejected_by_source else "merged_into_candidate",
                score=candidate.get("score"),
                reason=candidate.get("reason") if rejected_by_source else None,
                raw=candidate,
            )
            if not rejected_by_source:
                topic_signals["mergedIntoCandidate"] += 1
        inserted += 1
    topic_signals["notSelectedByModel"] = write_unselected_observation_signals(database, engine_run_id=engine_run_id, all_observation_ids=all_observation_ids, matched_observation_ids=matched_observation_ids, source_item_id_by_observation_id=source_item_id_by_observation_id)
    return {
        "ok": True,
        "inserted": inserted,
        "duplicates": shadow_duplicates,
        "dedupeRejected": shadow_duplicates,
        "dedupeAdvisory": deferred_duplicates + deferred_keywords,
        "sourceRejected": source_rejected,
        "topicDedupe": {"uniqueInserted": unique_inserted, "shadowDuplicates": shadow_duplicates, "deferredDuplicates": deferred_duplicates, "deferredKeywords": deferred_keywords, "sourceRejected": source_rejected},
        "topicSignals": topic_signals,
        "sourceScope": source_scope,
        "sourceScopeSummary": source_scope_summary,
        "warnings": validation.warnings[:10],
    }
