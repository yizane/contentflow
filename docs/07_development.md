# 07 — Development

## 环境

```bash
git pull && npm install
cp .env.example .env       # 填 MySQL（不进 Git）
npm run db:ping && npm run db:init && npm run db:migrate
```

依赖只有 mysql2 + dotenv（无 ORM、无框架）。OpenClaw 需本机配好（searxng search provider + web_fetch fake-IP 放行，见 docs/06）。

## 代码结构（scripts/）

- 连接层：`mysql_lib.js`（pool/query/insert/update/asJson/now/makeId）
- 核心：`pipeline_lib.js`（collect/topics/article/factcheck/channels/resolution/revision/score）
- 支撑：`prompt_lib`、`validate_data_lib`、`trace_lib`、`run_control_lib`、`internal_claims_lib`、`production_policy_lib`、`openclaw_lib`、`sources_lib`、`collect_http_lib`
- CLI 薄壳：engine_daily / engine_batch / 各 run_* / db_* / export / review / report / view_server

## 约定

- 新功能 = MySQL 表（migration）+ pipeline_lib 函数 + CLI 薄壳 + trace + docs
- OpenClaw 输出一律"回复中 JSON"，禁止让 Agent 写文件
- 状态变更必须写 status_transitions；模型调用必须经 callAgent（自动 model_runs + 事件）
- 临时文件只允许系统 temp，用完即删
