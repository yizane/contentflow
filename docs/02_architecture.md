# 02 — Architecture

```
config/ + prompts/ + schemas/（Git 静态资产）
        │
scripts/*.js（Node 零框架，mysql2 + dotenv）
        │  prompt_lib 组装任务字符串（内存）
        ▼
OpenClaw（执行层，不是状态库）── openclaw agent --message ... --json
        │  回复 JSON 解析（extractJson）→ validate_data_lib 对象校验
        ▼
MySQL（唯一 runtime source of truth，阿里云 RDS）
        ▲
        ├── 本地 Viewer（只读 + run 触发，127.0.0.1）
        └── Web 项目（独立仓库，只连 MySQL）
```

要点：

- **MySQL 是唯一 runtime source of truth**；`output/`、`data/*.sqlite` 为 legacy（已移 `legacy/`），不参与运行
- **OpenClaw 是执行层**：每次调用的 prompt / raw_response / parsed_output 落 model_runs，状态永远以 MySQL 为准
- 三层一致性防线：JSON schema 契约 → 对象校验（validate_data_lib）→ 评审 Agent（质量门/事实核查/双评分）
- Daily Run 幂等：run_control_lib（一天一个 active daily run）
- trace 四表（workflow_steps/source_collection_logs/workflow_events/status_transitions）供 Viewer 与未来 Web 复用
- prompt/raw_response 属内部数据，任何前端不应默认展示
