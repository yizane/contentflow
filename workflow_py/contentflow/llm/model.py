from __future__ import annotations

import json
import os
import re
import time
from typing import Any

from contentflow.core import db, trace
from contentflow.llm.providers import router


def estimate_tokens(text: str | None) -> int:
    if not text:
        return 0
    cjk = len(re.findall(r"[\u3400-\u9fff]", text))
    rest = len(text) - cjk
    return int(cjk + (rest + 3) // 4)


def extract_usage(raw: Any, prompt: str, response: str) -> dict[str, Any]:
    usage = None
    if isinstance(raw, dict):
        usage = raw.get("usage") or raw.get("token_usage")
        if usage is None and isinstance(raw.get("response"), dict):
            usage = raw["response"].get("usage")
        if usage is None and isinstance(raw.get("result"), dict):
            usage = raw["result"].get("usage")
    if isinstance(usage, dict):
        return {
            "exact": True,
            "inputTokens": usage.get("prompt_tokens", usage.get("input_tokens", usage.get("inputTokens"))),
            "outputTokens": usage.get("completion_tokens", usage.get("output_tokens", usage.get("outputTokens"))),
            "totalTokens": usage.get("total_tokens", usage.get("totalTokens")),
            "raw": usage,
        }
    input_tokens = estimate_tokens(prompt)
    output_tokens = estimate_tokens(response)
    return {"exact": False, "inputTokens": input_tokens, "outputTokens": output_tokens, "totalTokens": input_tokens + output_tokens}


def extract_json(text: str | None) -> Any:
    if not text:
        return None
    raw = text.strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", raw)
    if fence:
        try:
            return json.loads(fence.group(1))
        except json.JSONDecodeError:
            pass
    decoder = json.JSONDecoder()
    for index, char in enumerate(raw):
        if char not in "[{":
            continue
        try:
            value, _end = decoder.raw_decode(raw[index:])
        except json.JSONDecodeError:
            continue
        return value
    return None


def route_key_for_task(task_type: str) -> str:
    known = {
        "article_generation",
        "article_revision",
        "article_quality_score",
        "channel_repurpose",
        "content_classification",
        "fact_check",
        "seo_geo_score",
        "source_resolution",
        "topic_generation",
        "topic_value_score",
    }
    if task_type in known:
        return task_type
    return task_type or "fact_check"


def call_agent(
    *,
    task_type: str,
    prompt: str,
    session_key: str,
    engine_run_id: str | None = None,
    article_id: str | None = None,
    article_version_id: str | None = None,
    timeout_sec: int = 900,
    trace_writer: trace.TraceWriter | None = None,
    db_client: Any | None = None,
    run_task=router.run_task,
) -> dict[str, Any]:
    database = db_client or db.Database()
    writer = trace_writer or trace.TraceWriter(db_client=database)
    route_key = route_key_for_task(task_type)
    route = router.resolve_route(route_key)
    provider = route.provider_key
    model = route.model
    started_at = db.now()
    wall_started = time.monotonic()
    step_id = os.environ.get("WORKFLOW_STEP_ID")
    writer.log_workflow_event(
        engine_run_id=engine_run_id,
        workflow_step_id=step_id,
        event_type="openclaw_call_started",
        level="info",
        message=f"{provider} {task_type} 调用开始",
        related_type="model_run",
        data={"task_type": task_type, "provider": provider, "model_name": model, "session_key": session_key},
    )

    def progress_callback(progress: dict[str, Any]) -> None:
        event = str(progress.get("event") or "progress")
        elapsed_ms = int(progress.get("elapsedMs") or 0)
        writer.log_workflow_event(
            engine_run_id=engine_run_id,
            workflow_step_id=step_id,
            event_type="openclaw_call_progress",
            level="info",
            message=f"{provider} {task_type} 进行中：{event}（{elapsed_ms}ms）",
            related_type="model_run",
            data={"task_type": task_type, "provider": provider, "model_name": model, "session_key": session_key, **progress},
        )

    result = run_task(task_type=route_key, message=prompt, session_key=session_key, timeout_sec=timeout_sec, route=route, progress_callback=progress_callback)
    parsed = extract_json(result.visible_text) if result.ok else None
    duration_ms = result.duration_ms or int((time.monotonic() - wall_started) * 1000)
    usage = extract_usage(result.raw, prompt, result.visible_text or "")
    model_run_id = db.record_model_run({
        "engineRunId": engine_run_id,
        "articleId": article_id,
        "articleVersionId": article_version_id,
        "taskType": task_type,
        "provider": provider,
        "model": model,
        "sessionKey": session_key,
        "taskPrompt": prompt,
        "rawResponse": (result.visible_text or "")[:4_000_000] if result.ok else None,
        "parsedOutput": parsed,
        "status": "succeeded" if result.ok and parsed is not None else "failed",
        "startedAt": started_at,
        "error": None if result.ok and parsed is not None else ("回复中无法解析 JSON" if result.ok else result.error),
        "rawSummary": {
            "durationMs": duration_ms,
            "promptChars": len(prompt),
            "responseChars": len(result.visible_text or ""),
            "usage": usage,
        },
    }, db_client=database)
    ok = result.ok and parsed is not None
    writer.log_workflow_event(
        engine_run_id=engine_run_id,
        workflow_step_id=step_id,
        event_type="openclaw_call_completed" if ok else "openclaw_call_failed",
        level="info" if ok else "error",
        message=f"{provider} {task_type} 完成（{duration_ms}ms）" if ok else f"{provider} {task_type} 失败: {(result.error or '无法解析 JSON')[:150]}",
        related_type="article",
        related_id=article_id,
        data={"task_type": task_type, "model_name": model, "session_key": session_key, "duration_ms": duration_ms, "parsed_ok": parsed is not None, "tokens": usage, "cost": None},
    )
    if not result.ok:
        return {"ok": False, "error": result.error, "modelRunId": model_run_id}
    if parsed is None:
        return {"ok": False, "error": f"回复中无法解析 JSON: {(result.visible_text or '')[:150]}", "modelRunId": model_run_id}
    return {"ok": True, "data": parsed, "modelRunId": model_run_id}
