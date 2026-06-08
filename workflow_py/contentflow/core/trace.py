from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any

from . import db


@dataclass(slots=True)
class TraceFailures:
    count: int = 0
    samples: list[str] = field(default_factory=list)


def clip(value: Any, max_chars: int = 2000) -> Any:
    if value is None:
        return None
    text = json.dumps(value, ensure_ascii=False)
    if len(text) <= max_chars:
        return value
    return {"_truncated": True, "preview": text[:max_chars]}


class TraceWriter:
    def __init__(self, db_client: Any | None = None):
        self.db = db_client or db.Database()
        self.failures = TraceFailures()
        self._started_wall_ms: dict[str, float] = {}

    def _safe(self, label: str, fn):
        try:
            return fn()
        except Exception as exc:  # trace must not break the workflow
            self.failures.count += 1
            if len(self.failures.samples) < 5:
                self.failures.samples.append(f"{label}: {exc}")
            return None

    def create_workflow_step(self, *, engine_run_id: str | None, step_key: str, step_name: str | None, step_order: int | None, input_summary: Any = None) -> str | None:
        step_id = db.make_id("step")
        now = db.now()
        self._started_wall_ms[step_id] = time.time() * 1000

        def write():
            self.db.insert("workflow_steps", {
                "id": step_id,
                "engine_run_id": engine_run_id,
                "step_key": step_key,
                "step_name": step_name or step_key,
                "step_order": step_order,
                "status": "pending",
                "started_at": now,
                "input_summary_json": clip(input_summary),
                "created_at": now,
                "updated_at": now,
            })
            return step_id

        return self._safe(f"createWorkflowStep({step_key})", write)

    def start_workflow_step(self, step_id: str | None) -> None:
        if not step_id:
            return
        now = db.now()
        self._started_wall_ms[step_id] = time.time() * 1000
        self._safe("startWorkflowStep", lambda: self.db.update("workflow_steps", {"status": "running", "started_at": now, "updated_at": now}, "id = %s", [step_id]))

    def finish_workflow_step(self, step_id: str | None, *, status: str = "success", output_summary: Any = None, warnings: Any = None, error_message: str | None = None) -> None:
        if not step_id:
            return

        def write():
            finished = db.now()
            started = self._started_wall_ms.pop(step_id, None)
            duration_ms = int(max(0, time.time() * 1000 - started)) if started else None
            self.db.update("workflow_steps", {
                "status": status,
                "finished_at": finished,
                "duration_ms": duration_ms,
                "output_summary_json": clip(output_summary),
                "warning_json": clip(warnings),
                "error_message": error_message[:900] if error_message else None,
                "updated_at": finished,
            }, "id = %s", [step_id])

        self._safe("finishWorkflowStep", write)

    def log_workflow_event(self, *, engine_run_id: str | None, workflow_step_id: str | None = None, event_type: str, level: str = "info", message: str = "", related_type: str | None = None, related_id: str | None = None, data: Any = None) -> None:
        self._safe(f"logWorkflowEvent({event_type})", lambda: self.db.insert("workflow_events", {
            "id": db.make_id("evt"),
            "engine_run_id": engine_run_id,
            "workflow_step_id": workflow_step_id,
            "event_type": event_type,
            "level": level,
            "message": str(message)[:2000],
            "related_type": related_type,
            "related_id": related_id,
            "data_json": clip(data),
            "created_at": db.now(),
        }))


default_writer = TraceWriter()
