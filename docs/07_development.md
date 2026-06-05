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
- 支撑：`prompt_lib`、`validate_data_lib`、`trace_lib`、`run_control_lib`、`internal_claims_lib`、`production_policy_lib`、`providers/`（模型执行器层）、`sources_lib`、`collect_http_lib`
- CLI 薄壳：engine_daily / engine_batch / 各 run_* / db_* / export / review / report / view_server

## 约定

- 新功能 = MySQL 表（migration）+ pipeline_lib 函数 + CLI 薄壳 + trace + docs
- OpenClaw 输出一律"回复中 JSON"，禁止让 Agent 写文件
- 状态变更必须写 status_transitions；模型调用必须经 callAgent（自动 model_runs + 事件）
- 临时文件只允许系统 temp，用完即删

## scripts/ 目录结构与命名约定（Phase 12 整理后）

```
scripts/
├── pipeline/        # 工作流步骤（engine_batch 串起来的内容生产流水线 + 人工终审）
│   sources_collect / topics_generate / jobs_create / jobs_run / factcheck_run /
│   sources_fix / sources_resolve / articles_revise / channels_generate /
│   score_seo_geo / content_classify / package_export / review_mark
├── tools/           # 人工运维命令（部署生命周期 + 排查；docs/06 运维手册引用）
│   db_ping / db_init / db_migrate / db_list / db_show / sources_check / config_sync
├── lib/             # 内部库（*_lib.js，不可直接执行）
└── engine_daily / engine_batch / engine_report / view_server   # 编排层与服务
```

- CLI 命名 `域_动作.js`，与 npm script `域:动作` 一一对应；`workflow_steps.step_key` 同一套命名（migration 007 已迁移历史数据）。
- 新项目无外部消费者，不保留旧命名别名。
- **一次性检查/调试不要加脚本**：用临时 `node -e` 代码即可，仓库里的 tools 必须有「被流水线/文档/运维流程引用」的理由。
- lib/ 内部 `ROOT` 为 `path.resolve(__dirname, '..', '..')`（上跳两级到仓库根）。

## 模型执行器层（providers）

所有模型调用经 `scripts/lib/providers/` 统一路由与分发，pipeline 不直接依赖任何具体 CLI：

- **路由**：`resolveRoute(taskType)` 读 `config/models.yaml`——task 段第一个 enabled 项决定该节点用哪个执行器 + 哪个模型，缺省回退 `default`。
- **执行器**（契约 `run({...}) → { ok, error, visibleText, raw, durationMs }`）：
  - `openclaw_cli`：生产路径（本地 OpenClaw CLI）
  - `codex_cli` / `claude_cli`：本地 CLI 预留（实验性，未在生产验证）
  - `openai_api`：OpenAI 兼容 HTTP（/chat/completions；OpenAI、DeepSeek、vLLM、Ollama 等），配 `base_url` + `api_key_env` 即可
  - `openclaw_gateway`：远程网关占位（协议待定）
- 按节点配置示例——给分类任务换执行器只改 models.yaml，不动代码：

  ```yaml
  content_classification:
    - name: deepseek
      provider: openai_api
      model: deepseek-chat
      enabled: true
  ```
- `model_runs.model_provider` 记录实际执行器 key，可审计每次调用走了哪条路。
