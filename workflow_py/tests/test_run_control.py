from __future__ import annotations

from contentflow.flow import run_control


class ArchiveDB:
    def __init__(self):
        self.updates: list[tuple[str, dict, str, list]] = []

    def query(self, sql, params=None):
        if "FROM topic_candidates" in sql:
            return []
        if "FROM article_writing_tasks" in sql:
            return [{"id": "task_1", "status": "pending"}]
        if "FROM articles WHERE engine_run_id" in sql:
            return []
        return []

    def update(self, table, data, where_sql, where_params=None):
        self.updates.append((table, data, where_sql, where_params or []))


def test_archive_run_data_counts_writing_tasks_and_finishes_run():
    database = ArchiveDB()

    result = run_control.archive_run_data(engine_run_id="engine_old", superseded_by="engine_new", db_client=database)

    assert result["counts"]["articleWritingTasks"] == 1
    assert "articleJobs" not in result["counts"]
    assert any(table == "article_writing_tasks" and data["status"] == "cancelled" for table, data, *_ in database.updates)
    assert any(
        table == "engine_runs"
        and data["status"] == "superseded"
        and data["is_active"] == 0
        and data["superseded_by"] == "engine_new"
        and data.get("finished_at")
        for table, data, *_ in database.updates
    )
