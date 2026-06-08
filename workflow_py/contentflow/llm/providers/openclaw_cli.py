from __future__ import annotations

import json
import re
import subprocess
import time
from collections.abc import Callable
from typing import Any


def parse_openclaw_stdout(stdout: str) -> dict[str, Any]:
    parsed = None
    text = stdout.strip()
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"(\{[\s\S]*\})\s*$", text)
        if match:
            parsed = json.loads(match.group(1))
    if parsed is None:
        return {"raw": None, "visible_text": text or None}

    result = parsed.get("result", parsed) if isinstance(parsed, dict) else parsed
    visible = None
    if isinstance(result, dict):
        response = result.get("response")
        if isinstance(response, dict):
            visible = response.get("finalAssistantVisibleText") or response.get("finalAssistantRawText")
        payloads = result.get("payloads")
        if visible is None and isinstance(payloads, list) and payloads:
            first = payloads[0]
            if isinstance(first, dict):
                visible = first.get("text")
    return {"raw": parsed, "visible_text": visible}


def run(*, provider_cfg: dict[str, Any], model: str | None, message: str, session_key: str, timeout_sec: int = 900, entry: dict[str, Any] | None = None, progress_callback: Callable[[dict[str, Any]], None] | None = None) -> dict[str, Any]:
    command = provider_cfg.get("command") or "openclaw"
    args = [command, "agent", "--session-key", session_key, "--message", message, "--timeout", str(timeout_sec), "--json"]
    if model:
        args.extend(["--model", model])
    started = time.time()
    try:
        proc = subprocess.Popen(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if progress_callback:
            progress_callback({"event": "process_started", "elapsedMs": 0})
        while True:
            try:
                stdout, stderr = proc.communicate(timeout=30)
                break
            except subprocess.TimeoutExpired:
                if progress_callback:
                    progress_callback({"event": "heartbeat", "elapsedMs": int((time.time() - started) * 1000)})
                if time.time() - started > timeout_sec + 60:
                    proc.kill()
                    stdout, stderr = proc.communicate()
                    return {"ok": False, "error": "openclaw CLI 调用超时", "visibleText": None, "raw": None, "durationMs": int((time.time() - started) * 1000)}
    except Exception as exc:
        return {"ok": False, "error": f"openclaw CLI 调用失败: {str(exc)[:600]}", "visibleText": None, "raw": None, "durationMs": int((time.time() - started) * 1000)}
    if proc.returncode != 0:
        error = (stderr or stdout or "").strip()[:600]
        return {"ok": False, "error": f"openclaw CLI 调用失败: {error}", "visibleText": None, "raw": None, "durationMs": int((time.time() - started) * 1000)}
    parsed = parse_openclaw_stdout(stdout)
    return {
        "ok": True,
        "error": None,
        "visibleText": parsed["visible_text"],
        "raw": parsed["raw"],
        "durationMs": int((time.time() - started) * 1000),
    }
