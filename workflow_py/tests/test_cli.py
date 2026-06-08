import json
import os
import subprocess
import sys
from pathlib import Path

WORKFLOW_PY = Path(__file__).resolve().parents[1]


def run_cli(*args, env=None):
    merged_env = os.environ.copy()
    merged_env.update(env or {})
    proc = subprocess.run(
        [sys.executable, "-m", "contentflow.cli", *args],
        cwd=WORKFLOW_PY,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=merged_env,
        check=False,
    )
    return proc


def test_engine_batch_dry_run_outputs_json_plan():
    proc = run_cli("engine", "batch", "--limit", "1", "--target-ready", "5", "--dry-run")
    assert proc.returncode == 0, proc.stderr

    payload = json.loads(proc.stdout)
    assert payload["ok"] is True
    assert payload["dryRun"] is True
    assert payload["runner"] == "python"
    assert payload["plan"]["targetReady"] == 5
    assert payload["plan"]["steps"][0]["stepKey"] == "sources_collect"
    assert payload["plan"]["steps"][3]["command"] == "topics:select"


def test_cli_uses_repo_root_env_file():
    proc = run_cli("env", "path")
    assert proc.returncode == 0, proc.stderr

    payload = json.loads(proc.stdout)
    assert payload["envPath"].endswith("/.env")
    assert "/workflow_py/" not in payload["envPath"]


def test_engine_daily_dry_run_does_not_require_mysql():
    proc = run_cli("engine", "daily", "--dry-run", "--daily-key", "2026-06-07")
    assert proc.returncode == 0, proc.stderr

    payload = json.loads(proc.stdout)
    assert payload["ok"] is True
    assert payload["dryRun"] is True
    assert payload["dailyKey"] == "2026-06-07"


def test_db_ping_reports_missing_mysql_env_without_fallback():
    env = {
        "MYSQL_HOST": "",
        "MYSQL_DATABASE": "",
        "MYSQL_USER": "",
        "MYSQL_PASSWORD": "",
    }
    proc = run_cli("db", "ping", env=env)
    assert proc.returncode == 1

    payload = json.loads(proc.stdout)
    assert payload["ok"] is False
    assert "MySQL 未配置" in payload["error"]
    assert "不 fallback SQLite" in payload["error"]


def test_python_cli_exposes_workflow_parity_commands():
    commands = [
        ("db", "show", "--help"),
        ("engine", "report", "--help"),
        ("sources", "fix", "--help"),
        ("sources", "backfill-canonical", "--help"),
        ("topic", "audition", "--help"),
        ("keywords", "analyze", "--help"),
        ("config", "sync", "--help"),
    ]
    for args in commands:
        proc = run_cli(*args)
        assert proc.returncode == 0, f"{args}: {proc.stderr}\n{proc.stdout}"
