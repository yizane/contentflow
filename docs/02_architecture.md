# 02 — Architecture

```text
config/ + prompts/ + schemas/ + db/
        │
workflow_py/contentflow（Python runtime）
        │  flow/ 编排主链路与 step registry
        │  domains/ 承载采集、选题、生产、分类业务节点
        │  llm/ 组装 prompt、调用 OpenClaw provider、做 schema + 业务校验
        ▼
OpenClaw CLI（执行层，不是状态库）
        │
        ▼
MySQL（唯一 runtime source of truth）
        ▲
        ├── Viewer / Web（独立维护，只读 + 受控触发 Python）
        └── Web 项目（独立仓库，只连 MySQL）
```

要点：

- **MySQL 是唯一 runtime source of truth**；不使用本地 output 或 SQLite fallback。
- **Python 是唯一 workflow runtime**；不保留 root npm/Node 兼容入口。
- **OpenClaw 是执行层**：每次调用的 prompt / raw_response / parsed_output 落 `model_runs`。
- 一致性防线：JSON Schema → `contentflow.llm.validators` → 事实核查/质量门/SEO-GEO 辅助评分。
- Daily Run 幂等：`contentflow.flow.run_control` 管理一天一个 active daily run。
- trace 四表供 Viewer 与未来 Web 复用：`workflow_steps`、`source_collection_logs`、`workflow_events`、`status_transitions`。
- prompt/raw_response 属内部数据，任何前端不应默认展示。
