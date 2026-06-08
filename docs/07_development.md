# 07 — Development

## 环境

```bash
git pull
cd workflow_py
uv sync
cp .env.example .env
uv run contentflow db ping
uv run contentflow db init
uv run contentflow db migrate
uv run pytest
```

依赖：

- Python 3.12 + uv：workflow runtime
- MySQL 8.x：唯一 runtime data store
- OpenClaw CLI：模型执行层

## 代码结构

```text
workflow_py/
├── contentflow/
│   ├── cli.py                # 极薄入口
│   ├── commands/             # Typer 命令分组
│   ├── core/                 # config / db / trace
│   ├── flow/                 # daily / run_control / runtime / steps / graph
│   ├── domains/              # sources / topics / production / taxonomy
│   ├── llm/                  # model / prompts / validators / providers
│   └── ops/                  # report / maintenance
├── tests/
└── pyproject.toml

webpage/                       # Viewer 区域，Claude 维护；workflow 不放这里
```

不要把 workflow 逻辑放回 Node 或 Viewer 目录。

## 开发规则

- 新 workflow 功能 = Python 模块 + pytest + MySQL trace/审计 + docs。
- 新配置或 prompt 改动后运行 `uv run contentflow config sync`。
- 新 migration 放 `db/mysql_migrations/`，编号顺延。
- 模型调用必须经 `contentflow.llm.model.call_agent`，保证 `model_runs` 和 workflow events。
- 采集解析优先用成熟库或独立 crawler；不要手写脆弱 HTML/string parser。
- 不写本地 output 作为运行时状态。

## 测试

```bash
cd workflow_py
uv run pytest
uv run contentflow engine batch --limit 1 --dry-run
uv run contentflow sources check
uv run contentflow keywords analyze
```

## Python CLI

常用入口：

```bash
uv run contentflow engine batch --limit 1 --target-ready 5
uv run contentflow engine daily --mode retry
uv run contentflow sources collect --daily-key 2026-06-08
uv run contentflow topics generate --engine-run-id <run_id>
uv run contentflow topics select --limit 1 --dry-run
uv run contentflow articles generate --limit 1
uv run contentflow articles factcheck --limit 5
uv run contentflow score article-quality --status ready_for_review
uv run contentflow engine report
```

## Provider

模型执行由 Python provider 层处理：

- 配置：`config/models.yaml`
- 路由：`contentflow.llm.providers.router`
- 生产执行：`contentflow.llm.providers.openclaw_cli`
- 调用封装：`contentflow.llm.model.call_agent`

`model_runs.model_provider` 记录实际 provider key。

## Viewer 边界

Viewer 由 Claude 在 `webpage/` 维护。workflow 侧只维护 Python CLI、MySQL 数据契约和文档说明。
