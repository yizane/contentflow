from __future__ import annotations

from contentflow.llm import model
from contentflow.llm.providers.router import ProviderResult


class FakeDB:
    def __init__(self):
        self.inserts = []

    def insert(self, table, data):
        self.inserts.append((table, data))


def test_extract_json_accepts_plain_fenced_and_noisy_json():
    assert model.extract_json('{"ok": true}') == {"ok": True}
    assert model.extract_json('```json\n{"a": 1}\n```') == {"a": 1}
    assert model.extract_json('text before {"b": 2} text after') == {"b": 2}
    assert model.extract_json("not json") is None


def test_call_agent_records_model_run_and_returns_parsed_json():
    fake_db = FakeDB()

    def fake_run_task(**_kwargs):
        return ProviderResult(ok=True, error=None, visible_text='{"answer": 42}', raw={"usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12}}, duration_ms=123)

    result = model.call_agent(
        task_type="fact_check",
        prompt="hello",
        session_key="session_test",
        engine_run_id="engine_test",
        db_client=fake_db,
        run_task=fake_run_task,
    )

    assert result["ok"] is True
    assert result["data"] == {"answer": 42}
    model_run = next(data for table, data in fake_db.inserts if table == "model_runs")
    assert model_run["engine_run_id"] == "engine_test"
    assert model_run["task_type"] == "fact_check"
    assert model_run["parsed_output_json"] == {"answer": 42}
    assert model_run["raw_summary_json"]["usage"]["totalTokens"] == 12
    assert len([1 for table, _ in fake_db.inserts if table == "workflow_events"]) == 2


def test_call_agent_records_provider_progress_events():
    fake_db = FakeDB()

    def fake_run_task(**kwargs):
        kwargs["progress_callback"]({"event": "heartbeat", "elapsedMs": 30000})
        return ProviderResult(ok=True, error=None, visible_text='{"answer": 42}', raw={}, duration_ms=30001)

    result = model.call_agent(
        task_type="fact_check",
        prompt="hello",
        session_key="session_test",
        engine_run_id="engine_test",
        db_client=fake_db,
        run_task=fake_run_task,
    )

    assert result["ok"] is True
    events = [data for table, data in fake_db.inserts if table == "workflow_events"]
    assert [event["event_type"] for event in events] == [
        "openclaw_call_started",
        "openclaw_call_progress",
        "openclaw_call_completed",
    ]
    assert events[1]["data_json"]["elapsedMs"] == 30000
