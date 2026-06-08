# 06 — Operations

## 日常命令

```bash
cd workflow_py
uv run contentflow engine daily                         # 默认日产目标 5 篇 ready_for_review
uv run contentflow engine daily --mode retry
uv run contentflow engine daily --mode rebuild
uv run contentflow sources fix --limit 5
uv run contentflow engine report
uv run contentflow sources check
uv run contentflow keywords analyze
```

## 排查指南

| 症状 | 查什么 |
|---|---|
| 采集失败 | `source_collection_logs WHERE status='failed'`；看 http_status、error_message、duration_ms |
| 某天采集量异常 | `source_observations WHERE daily_key=?`；canonical 去重后不要只看 `source_items.created_at` |
| OpenClaw 失败 | `model_runs WHERE status='failed'`；看 error_message 和 raw_response |
| 主题太少 | `topic_signals`、`topic_dedupe_records`、`topic_candidates.selection_skip_reason` |
| 高分题没被选 | `portfolio_debug_json`、`deferred_until`、`selection_status` |
| 文章没进终审 | `article_quality_scores`、`articles.article_quality_score`、`fact_checks.publish_readiness` |
| 待补来源堆积 | `articles.status='needs_fact_sources'`，逐篇跑 `uv run contentflow sources fix --article-id <id>` |
| 渠道缺失 | `channel_outputs`，或跑 `uv run contentflow channels generate --status ready_for_review --missing-only` |
| 发布包不完整 | `publish_packages.metadata_json` 中的 missing/suggestedCommand |

## Run Control

- `start`：当天没有 active daily run 才允许。
- `retry`：仅 failed/partial，跳过可复用产物。
- `rebuild`：归档旧 run 后完整重跑，不物理删除。
- `force`：创建额外 run，默认不抢 active。

触发和拒绝原因写 `run_actions`。不要绕过 daily run control 直接伪造 daily 数据。

## 选题压力测试

```bash
cd workflow_py
uv run contentflow topic audition --rounds 10 --limit 3 --refresh-candidates
uv run contentflow topic audition --rounds 20 --limit 1
uv run contentflow keywords analyze
```

重点看：未来选题日历、分类分布、平均价值分、重复风险、deferred 原因、source 支撑不足原因。

## 环境问题

- OpenClaw web_fetch 如需访问 198.18.0.0/15 Fake-IP，需允许 RFC2544 benchmark range。
- SearXNG JSON API 需要开启 `search.formats: [html, json]`。
- 代理节点抖动导致模型失败时，换节点后重跑；失败记录在 `model_runs` 和 `workflow_events`。
