# Flyfus Content Agent

面向中国亚马逊卖家的 **SEO/GEO 内容生产引擎**。workflow runtime 是 Python。

- **MySQL 是唯一 runtime source of truth**：正文、JSON、trace、审计都在库里。
- **Python workflow**：`workflow_py/contentflow` 负责采集、选题、生成、评分、渠道、发布包与报告。
- **Viewer 是独立调试台**：由 Claude 在 `webpage/` 维护，只通过 MySQL 和 Python CLI 对接。
- **OpenClaw 是模型执行层**：prompt/raw_response 落 `model_runs`，属于内部数据。
- **真实发布不在本项目内**：产出止于 `publish_packages` + 人工终审标记。

## 快速开始

```bash
git pull
cd workflow_py
uv sync
cp .env.example .env        # 填 MySQL 连接（.env 不进 Git）
uv run contentflow db ping
uv run contentflow db init
uv run contentflow db migrate
uv run contentflow engine batch --limit 1 --dry-run
uv run contentflow engine daily
```

依赖：Python 3.12、uv、MySQL 8.x、本机 OpenClaw。

## 主要命令

```bash
uv run contentflow engine daily                         # start；一天一个 active daily run
uv run contentflow engine daily --mode retry
uv run contentflow engine daily --mode rebuild
uv run contentflow engine batch --limit 1 --target-ready 5 --dry-run
uv run contentflow sources collect --daily-key 2026-06-08
uv run contentflow topics generate --engine-run-id <run_id>
uv run contentflow jobs create --limit 1 --dry-run
uv run contentflow jobs run --limit 1
uv run contentflow factcheck run --limit 5
uv run contentflow sources fix --limit 5
uv run contentflow channels generate --status ready_for_review --missing-only
uv run contentflow score article-quality --status ready_for_review
uv run contentflow package export --status ready_for_review --with-channels
uv run contentflow review mark --article-id <id> --status approved_for_publish
uv run contentflow topic audition --rounds 10 --limit 3
uv run contentflow engine report
uv run contentflow sources check
uv run pytest
```

## Runtime Data Model

Runtime 数据全部在 MySQL：

- 内容：`articles`、`article_versions`、`channel_outputs`、`publish_packages`、`quality_reports`、`fact_checks`、`source_resolutions`、`seo_geo_scores`、`topic_candidates`、`article_jobs`、`source_items`
- 运行：`engine_runs`、`model_runs`、`engine_reports`、`review_actions`、`run_actions`、`schema_migrations`
- 分类：`content_classifications`
- Trace：`workflow_steps`、`source_collection_logs`、`workflow_events`、`status_transitions`

## 代码结构

```text
workflow_py/contentflow/   Python workflow runtime
workflow_py/tests/         pytest
config/                    sources、models、taxonomy、portfolio policy
prompts/                   OpenClaw prompt seed
schemas/                   JSON Schema
db/                        MySQL schema/migrations
webpage/                   Viewer 区域，Claude 维护
docs/                      文档
```

## Viewer

Viewer 由 Claude 在 `webpage/` 维护。workflow 侧只保证 MySQL 表结构、`workflow_steps.step_key`、`engine_reports.report_json` 等数据契约。

## 内容铁律

1. 事实优先：无来源数字不写成事实；不确定信息降级表达。
2. Amazon/Google 官方事实只认官方域名来源；中文行业源主要作选题线索。
3. Flyfus 能力以 `config/internal_claims.yaml` 白名单为准；禁止承诺排名/推荐/ACoS。
4. 正文零 AI 工作流痕迹。
5. 命名口径：Amazon AI Shopping / Alexa for Shopping（Rufus 为历史名称与数据来源）。

## 边界

不做正式 Web UI（Viewer 仅本地调试）、不接 Strapi、不内置 Cron、不调用 Flyfus MCP、不真实发布、无 ORM、无本地文件运行时状态。
