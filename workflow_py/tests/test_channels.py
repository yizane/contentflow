from __future__ import annotations

from contentflow.domains.production.channels import run_channels


class FakeDB:
    def __init__(self):
        self.inserts = []
        self.updates = []
        self.article = {"id": "article_1", "slug": "article-one", "engine_run_id": "engine_test", "status": "ready_for_review"}
        self.version = {"id": "ver_1", "article_id": "article_1", "article_markdown": "# Title\n\nBody", "article_json": {}, "quality_json": {}, "fact_check_json": {}}

    def query(self, sql, params=None):
        if "FROM articles WHERE status" in sql:
            return [self.article]
        if "FROM article_versions" in sql:
            return [self.version]
        if "SELECT channel FROM channel_outputs" in sql:
            return []
        if "SELECT id FROM channel_outputs" in sql:
            return []
        return []

    def insert(self, table, data):
        self.inserts.append((table, data))

    def update(self, table, data, where_sql, where_params=None):
        self.updates.append((table, data, where_sql, where_params or []))


def channel_payload(channel):
    return {
        "channel": channel,
        "title": f"{channel} 渠道标题",
        "titleCandidates": ["标题1", "标题2", "标题3", "标题4", "标题5"] if channel == "xiaohongshu" else [],
        "contentMarkdown": "这是一段渠道改写内容。" * 20,
        "notes": "",
        "status": "generated",
    }


def test_run_channels_writes_three_default_channel_outputs():
    fake_db = FakeDB()

    def fake_call_agent(**_kwargs):
        return {"ok": True, "data": {channel: channel_payload(channel) for channel in ["wechat", "douyin", "xiaohongshu"]}}

    result = run_channels(status="ready_for_review", engine_run_id="engine_test", database=fake_db, call_agent=fake_call_agent)

    assert result["ok"] is True
    assert result["channelOutputsGenerated"] == 3
    assert len([1 for table, _ in fake_db.inserts if table == "channel_outputs"]) == 3
