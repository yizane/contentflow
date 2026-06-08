from __future__ import annotations

from contentflow.flow import daily as engine
from contentflow.flow import runtime
from contentflow.flow.steps import PythonStepBackend, StepOutcome, StepRunner


class FakeDB:
    def __init__(self, *, existing_run: bool = False):
        self.existing_run = existing_run
        self.inserts: list[tuple[str, dict]] = []
        self.updates: list[tuple[str, dict, str, list]] = []

    def query(self, sql, params=None):
        if "SELECT id FROM engine_runs" in sql:
            return [{"id": params[0]}] if self.existing_run else []
        if "COUNT(*) c FROM articles" in sql:
            return [{"c": 0}]
        if "COUNT(*) c FROM article_writing_tasks" in sql:
            return [{"c": 0}]
        return []

    def insert(self, table, data):
        self.inserts.append((table, data))

    def update(self, table, data, where_sql, where_params=None):
        self.updates.append((table, data, where_sql, where_params or []))


class NoCandidateRunner:
    def __init__(self):
        self.calls: list[tuple[str, bool]] = []

    def run_step(self, name, args=None, engine_run_id=None, *, skipped=False):
        self.calls.append((name, skipped))
        if name == "sources:collect":
            return StepOutcome(name=name, ok=True, result={"summary": {"total": 214}, "warnings": []})
        if name == "topics:generate":
            return StepOutcome(name=name, ok=True, result={"ok": True, "dedupeRejected": 0})
        if name == "topics:select":
            return StepOutcome(name=name, ok=True, result={"ok": True, "writingTaskCount": 0})
        return StepOutcome(name=name, ok=True, result={"ok": True})


def test_run_batch_real_control_flow_stops_when_no_candidates():
    fake_db = FakeDB()
    runner = NoCandidateRunner()
    args = runtime.parse_batch_args(["--run-id", "engine_test", "--target-ready", "5", "--max-attempts", "3"])

    summary = engine.run_batch(args, database=fake_db, step_runner=runner)

    assert summary["ok"] is False
    assert summary["engineRunId"] == "engine_test"
    assert summary["runner"] == "python"
    assert summary["stepBackend"] == "custom"
    assert summary["businessOutcome"] == "no_ready_articles"
    assert any("候选不足" in warning for warning in summary["warnings"])
    assert ("topics:select", False) in runner.calls
    assert ("channels:generate", True) in runner.calls
    assert any(table == "engine_runs" for table, _ in fake_db.inserts)
    assert any(table == "engine_runs" and data["status"] == "failed" for table, data, *_ in fake_db.updates)


def test_run_batch_runs_sources_fix_after_factcheck_finds_missing_sources():
    class DB(FakeDB):
        def query(self, sql, params=None):
            if "COUNT(*) c FROM articles" in sql and "status = 'ready_for_review'" in sql:
                return [{"c": 0}]
            if "COUNT(*) c FROM articles" in sql and "status = 'needs_fact_sources'" in sql:
                return [{"c": 1}]
            if "COUNT(*) c FROM articles" in sql:
                return [{"c": 0}]
            if "COUNT(*) c FROM article_writing_tasks" in sql:
                return [{"c": 0}]
            return super().query(sql, params)

    class Runner:
        backend = type("Backend", (), {"name": "test"})()

        def __init__(self):
            self.calls = []

        def run_step(self, name, args=None, engine_run_id=None, *, skipped=False):
            self.calls.append((name, skipped))
            if name == "sources:collect":
                return StepOutcome(name=name, ok=True, result={"summary": {"total": 1}, "warnings": []})
            if name == "topics:generate":
                return StepOutcome(name=name, ok=True, result={"ok": True, "dedupeRejected": 0})
            if name == "topics:select":
                return StepOutcome(name=name, ok=True, result={"ok": True, "writingTaskCount": 1})
            if name == "articles:generate":
                return StepOutcome(name=name, ok=True, result={"ok": True, "succeeded": 1, "failed": 0, "results": [{"ok": True}]})
            if name == "articles:factcheck":
                return StepOutcome(name=name, ok=True, result={"ok": True, "succeeded": 1, "failed": 0, "results": [{"ok": True, "articleStatus": "needs_fact_sources"}]})
            if name == "sources:fix":
                return StepOutcome(name=name, ok=True, result={"ok": True, "processed": 1, "stillNeedsSources": 0})
            return StepOutcome(name=name, ok=True, result={"ok": True})

    runner = Runner()
    args = runtime.parse_batch_args(["--run-id", "engine_sources_fix", "--target-ready", "5", "--max-attempts", "1"])

    engine.run_batch(args, database=DB(), step_runner=runner)

    names = [name for name, _ in runner.calls]
    assert names.index("sources:fix") > names.index("articles:factcheck")


def test_run_batch_updates_existing_run_id_instead_of_duplicate_insert():
    fake_db = FakeDB(existing_run=True)
    runner = NoCandidateRunner()
    args = runtime.parse_batch_args(["--run-id", "engine_existing", "--target-ready", "5"])

    engine.run_batch(args, database=fake_db, step_runner=runner)

    engine_run_inserts = [data for table, data in fake_db.inserts if table == "engine_runs"]
    assert engine_run_inserts == []
    running_updates = [data for table, data, *_ in fake_db.updates if table == "engine_runs" and data.get("status") == "running"]
    assert running_updates


def test_python_backend_can_run_sources_collect(monkeypatch):
    from contentflow.domains.sources import collect

    def fake_collect_sources(*, engine_run_id=None, database=None):
        return {"ok": True, "engineRunId": engine_run_id, "summary": {"total": 2}, "warnings": [], "perSource": [{"debug": True}]}

    monkeypatch.setattr(collect, "collect_sources", fake_collect_sources)
    backend = PythonStepBackend(enabled_steps={"sources:collect"}, database=FakeDB())

    outcome = backend.run(name="sources:collect", args=[], engine_run_id="engine_test", workflow_step_id="step_test")

    assert outcome.ok is True
    assert outcome.result == {"ok": True, "engineRunId": "engine_test", "summary": {"total": 2}, "warnings": []}


def test_python_backend_can_run_topics_generate(monkeypatch):
    from contentflow.domains.topics import generation

    def fake_generate_topics(*, engine_run_id=None, database=None):
        return {"ok": True, "engineRunId": engine_run_id, "inserted": 5}

    monkeypatch.setattr(generation, "generate_topics", fake_generate_topics)
    backend = PythonStepBackend(enabled_steps={"topics:generate"}, database=FakeDB())

    outcome = backend.run(name="topics:generate", args=[], engine_run_id="engine_test", workflow_step_id="step_test")

    assert outcome.ok is True
    assert outcome.result == {"ok": True, "engineRunId": "engine_test", "inserted": 5}


def test_python_backend_can_run_db_list():
    class DB(FakeDB):
        def query(self, sql, params=None):
            if "FROM articles" in sql:
                return [{"id": "article_1", "title": "Title", "status": "ready_for_review"}]
            return super().query(sql, params)

    backend = PythonStepBackend(enabled_steps={"db:list"}, database=DB())
    outcome = backend.run(name="db:list", args=["--limit", "10"], engine_run_id="engine_test", workflow_step_id="step_test")

    assert outcome.ok is True
    assert outcome.result["count"] == 1


def test_step_runner_summary_has_round_and_removes_noisy_fields():
    class Trace:
        def __init__(self):
            self.finished = []

        def create_workflow_step(self, **kwargs):
            return f"step_{kwargs['step_order']}"

        def start_workflow_step(self, _step_id):
            pass

        def finish_workflow_step(self, step_id, **kwargs):
            self.finished.append((step_id, kwargs))

        def log_workflow_event(self, **_kwargs):
            pass

    class Backend:
        name = "test"

        def run(self, **_kwargs):
            return StepOutcome(
                name="topics:select",
                ok=True,
                result={
                    "ok": True,
                    "writingTaskCount": 1,
                    "selected": [{"topic": "A"}],
                    "deferred": [],
                    "batchSkipped": [],
                    "items": [{"large": True}],
                    "results": [{"large": True}],
                    "warnings": [],
                },
            )

    trace = Trace()
    runner = StepRunner(trace_writer=trace, backend=Backend())

    runner.run_step("topics:select", engine_run_id="engine_test")
    runner.run_step("topics:select", engine_run_id="engine_test")

    output_summary = trace.finished[-1][1]["output_summary"]
    assert output_summary["round"] == 2
    assert output_summary["writingTaskCount"] == 1
    assert output_summary["selectedCount"] == 1
    assert "items" not in output_summary
    assert "results" not in output_summary


def test_step_runner_summary_uses_writing_task_count_only():
    class Trace:
        def __init__(self):
            self.finished = []

        def create_workflow_step(self, **kwargs):
            return f"step_{kwargs['step_order']}"

        def start_workflow_step(self, _step_id):
            pass

        def finish_workflow_step(self, step_id, **kwargs):
            self.finished.append((step_id, kwargs))

        def log_workflow_event(self, **_kwargs):
            pass

    class Backend:
        name = "test"

        def run(self, **_kwargs):
            return StepOutcome(
                name="topics:select",
                ok=True,
                result={
                    "ok": True,
                    "writingTaskCount": 1,
                    "writingTasks": [{"id": "task_1"}],
                    "selected": [{"topic": "A"}],
                },
            )

    trace = Trace()
    runner = StepRunner(trace_writer=trace, backend=Backend())

    runner.run_step("topics:select", engine_run_id="engine_test")

    output_summary = trace.finished[-1][1]["output_summary"]
    assert output_summary["writingTaskCount"] == 1
    assert "jobCount" not in output_summary
    assert "jobsCount" not in output_summary
    assert "jobs" not in output_summary


def test_run_batch_retries_final_engine_run_update_once():
    class DB(FakeDB):
        def __init__(self):
            super().__init__()
            self.final_update_failures = 0

        def update(self, table, data, where_sql, where_params=None):
            if table == "engine_runs" and "summary_json" in data and self.final_update_failures == 0:
                self.final_update_failures += 1
                raise RuntimeError("lost connection")
            super().update(table, data, where_sql, where_params)

    fake_db = DB()
    runner = NoCandidateRunner()
    args = runtime.parse_batch_args(["--run-id", "engine_retry_final", "--target-ready", "5", "--max-attempts", "3"])

    summary = engine.run_batch(args, database=fake_db, step_runner=runner)

    assert summary["ok"] is False
    assert fake_db.final_update_failures == 1
    assert any(table == "engine_runs" and data.get("summary_json") for table, data, *_ in fake_db.updates)


def test_run_batch_marks_failed_when_unexpected_error_happens_after_run_started():
    class DB(FakeDB):
        def query(self, sql, params=None):
            if "SELECT id FROM engine_runs" in sql:
                return []
            if "COUNT(*) c FROM articles" in sql:
                raise RuntimeError("lost connection during count")
            return super().query(sql, params)

    fake_db = DB()
    runner = NoCandidateRunner()
    args = runtime.parse_batch_args(["--run-id", "engine_mid_failure", "--target-ready", "5"])

    summary = engine.run_batch(args, database=fake_db, step_runner=runner)

    assert summary["ok"] is False
    assert summary["businessOutcome"] == "technical_failed"
    assert "lost connection during count" in summary["errors"][0]
    assert any(table == "engine_runs" and data.get("status") == "failed" and data.get("finished_at") for table, data, *_ in fake_db.updates)
