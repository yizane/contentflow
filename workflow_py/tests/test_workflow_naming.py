from __future__ import annotations

from pathlib import Path

from contentflow.flow import runtime
from contentflow.flow.steps import PythonStepBackend


WORKFLOW_ROOT = Path(__file__).resolve().parents[1] / "contentflow"


def test_workflow_steps_use_business_commands_not_generic_jobs():
    forbidden = {"jobs:create", "jobs:run", "factcheck:run"}

    assert forbidden.isdisjoint(PythonStepBackend.SUPPORTED_STEPS)

    plan = runtime.build_batch_dry_run_plan(runtime.parse_batch_args(["--limit", "1", "--target-ready", "5"]))
    commands = {step.get("command") for step in plan["steps"] if isinstance(step, dict)}
    assert forbidden.isdisjoint(commands)
    assert {"topics:select", "articles:generate", "articles:factcheck"}.issubset(commands)


def test_business_modules_do_not_keep_legacy_job_runner_files():
    assert not (WORKFLOW_ROOT / "domains" / "production" / "jobs.py").exists()
    assert not (WORKFLOW_ROOT / "domains" / "production" / "fact_gate.py").exists()
    assert (WORKFLOW_ROOT / "domains" / "topics" / "selection.py").exists()
    assert (WORKFLOW_ROOT / "domains" / "production" / "article_generation.py").exists()
    assert (WORKFLOW_ROOT / "domains" / "production" / "factcheck.py").exists()


def test_article_generation_uses_writing_task_names_not_queue_names():
    source = (WORKFLOW_ROOT / "domains" / "production" / "article_generation.py").read_text(encoding="utf-8")

    assert "generate_articles_from_writing_tasks" in source
    assert "generate_articles_from_queue" not in source
