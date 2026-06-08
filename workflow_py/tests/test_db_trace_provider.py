from datetime import datetime

from contentflow.core import db, trace
from contentflow.llm.providers import openclaw_cli, router


def test_db_json_helpers_and_id_shape():
    assert db.as_json('{"a": 1}') == {"a": 1}
    assert db.as_json({"b": 2}) == {"b": 2}
    assert db.as_json("not-json") is None
    assert db.make_id("evt").startswith("evt_")
    assert len(db.sha256("abc")) == 64


def test_trace_writer_counts_failures_without_raising():
    class FailingDB:
        def insert(self, *_args, **_kwargs):
            raise RuntimeError("db down")

    writer = trace.TraceWriter(db_client=FailingDB())

    assert writer.failures.count == 0
    assert writer.create_workflow_step(
        engine_run_id="run_test",
        step_key="sources_collect",
        step_name="sources:collect",
        step_order=1,
        input_summary={"args": []},
    ) is None
    assert writer.failures.count == 1
    assert "createWorkflowStep" in writer.failures.samples[0]


def test_openclaw_parser_extracts_visible_text_from_json():
    stdout = '{"result":{"response":{"finalAssistantVisibleText":"hello"}}}'
    parsed = openclaw_cli.parse_openclaw_stdout(stdout)
    assert parsed["visible_text"] == "hello"
    assert parsed["raw"]["result"]["response"]["finalAssistantVisibleText"] == "hello"


def test_openclaw_parser_accepts_trailing_json_object():
    stdout = 'noise before\\n{"payloads":[{"text":"payload text"}]}'
    parsed = openclaw_cli.parse_openclaw_stdout(stdout)
    assert parsed["visible_text"] == "payload text"


def test_router_passes_progress_callback_to_openclaw(monkeypatch):
    captured = {}

    def fake_resolve_route(_task_type):
        return router.ProviderRoute(provider_key="openclaw_cli", provider_cfg={"enabled": True}, model="test-model", entry={})

    def fake_run(**kwargs):
        captured["progress_callback"] = kwargs.get("progress_callback")
        return {"ok": True, "error": None, "visibleText": '{"ok": true}', "raw": {}, "durationMs": 1}

    monkeypatch.setattr(router, "resolve_route", fake_resolve_route)
    monkeypatch.setattr(openclaw_cli, "run", fake_run)
    progress_seen = []

    result = router.run_task(task_type="fact_check", message="hello", session_key="s", progress_callback=progress_seen.append)

    assert result.ok is True
    captured["progress_callback"]({"event": "heartbeat"})
    assert progress_seen == [{"event": "heartbeat"}]


def test_print_json_serializes_datetime(capsys):
    from contentflow.commands.common import print_json

    print_json({"ok": True, "createdAt": datetime(2026, 6, 8, 9, 30)})

    assert '"createdAt": "2026-06-08 09:30:00"' in capsys.readouterr().out
