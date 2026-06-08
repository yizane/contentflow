# ContentFlow Workflow Python

`workflow_py/` 是 ContentFlow 的正式 workflow runtime。workflow 不保留 Node 兼容入口。

## 边界

- 复用仓库根目录 `.env`。
- MySQL 是唯一 runtime source of truth，不 fallback SQLite。
- OpenClaw CLI 是模型执行层，Python provider 负责调用、解析和审计。
- Viewer 不迁入本目录；Viewer/Web 只通过 MySQL 和 `uv run contentflow ...` 对接 workflow。
- 基础能力优先使用开源库：Typer、Pydantic Settings、PyMySQL、PyYAML、httpx、feedparser、BeautifulSoup、trafilatura、courlan、rapidfuzz、jsonschema、sqlparse、tenacity、LangGraph。

## 使用

```bash
cd workflow_py
uv sync
uv run pytest
uv run contentflow db ping
uv run contentflow db migrate
uv run contentflow engine batch --limit 1 --target-ready 5 --dry-run
uv run contentflow engine daily --plan-only --daily-key 2026-06-08
uv run contentflow engine daily
```

主链路单步：

```bash
uv run contentflow sources collect --daily-key 2026-06-08
uv run contentflow topics generate --engine-run-id <run_id>
uv run contentflow topics select --limit 1 --engine-run-id <run_id>
uv run contentflow articles generate --limit 1 --engine-run-id <run_id>
uv run contentflow articles factcheck --limit 1 --engine-run-id <run_id>
uv run contentflow score seo-geo --status ready_for_review
uv run contentflow channels generate --status ready_for_review --missing-only
```

辅助链路：

```bash
uv run contentflow score article-quality --status ready_for_review
uv run contentflow sources resolve --article-id <article_id>
uv run contentflow sources fix --article-id <article_id>
uv run contentflow articles revise --article-id <article_id>
uv run contentflow content classify --all --limit 100 --no-ai
uv run contentflow package export --status ready_for_review
uv run contentflow review mark --article-id <article_id> --status reviewed
uv run contentflow topic audition --rounds 10 --limit 3
uv run contentflow engine report
```

运维工具：

```bash
uv run contentflow sources check
uv run contentflow keywords analyze
uv run contentflow config sync
uv run contentflow sources backfill-canonical
uv run contentflow db list --with-scores
uv run contentflow db show --id <article_id>
```

## 目录结构

```text
contentflow/
├── cli.py                    # 极薄入口，只启动 Typer app
├── commands/                 # CLI 命令分组：db / engine / sources / topics / production / ops / graph
├── core/                     # 配置、MySQL、trace 审计
├── flow/                     # batch/daily 编排、run control、step registry、LangGraph 图
├── domains/
│   ├── sources/              # source lane、AMZ123 crawler、RSS/page collector、正文抽取、observation ingest
│   ├── topics/               # topic generation、dedupe、source relevance、audition
│   ├── production/           # article_generation、factcheck、quality、scoring、channels、package、review
│   └── taxonomy/             # 内容分类
├── llm/
│   ├── providers/            # OpenClaw CLI provider、provider router
│   ├── model.py              # 模型调用审计、JSON 抽取
│   ├── prompts.py            # prompt 组装
│   └── validators.py         # schema + 业务校验
└── ops/                      # engine report、配置同步、来源检查、关键词分析、canonical 回填
```

核心路径：

- `contentflow.flow.daily`：batch/daily 编排和 target-ready 补位循环。
- `contentflow.flow.graph`：可视化/可检查的主链路图。
- `contentflow.flow.steps`：step_key 与 Python 函数的唯一映射。
- `contentflow.core.db`：MySQL 连接、migration、基础读写。
- `contentflow.llm.model.call_agent`：模型调用统一入口，保证 `model_runs` 和 workflow events。

## 注意

- `topics:select` 和 `topics:audition` 复用同一套 portfolio balancer；写作任务队列只是底层任务表。
- topic prompt 优先使用 `source_items.content_text` 截断片段，其次使用 summary。
- URL canonical、标题近似重复、RSS/HTML 解析、正文抽取均走开源库；项目内只保留业务规则。
