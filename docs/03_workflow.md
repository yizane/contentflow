# 03 — Workflow

## 主链路

```text
资料采集
→ 候选主题生成
→ 补位循环（选题入选与写作排队 → 文章初稿生成 → 事实核查与来源门禁）
→ SEO/GEO 辅助评分
→ 渠道改写
→ 发布包 / 人工终审
→ 运行报告
```

`workflow_steps.step_key` 使用业务语义命名；底层写作任务表只是实现细节，不作为主链路节点。

| 中文节点 | 内部 step_key | 做什么 |
|---|---|---|
| 资料采集 | `sources_collect` | 抓取每日数据源，抽取正文，写入 observation/canonical/source_items。 |
| 候选主题生成 | `topics_generate` | 基于素材生成候选主题，做来源相关性、去重和主题信号记录。 |
| 选题入选与写作排队 | `topics_select` | 组合选择器从候选主题中选出本轮要写的题目，创建写作任务。 |
| 文章初稿生成 | `articles_generate` | 根据入选题目生成文章、版本、视觉规划和初始质量结果。 |
| 事实核查与来源门禁 | `articles_factcheck` | 核查事实，决定能否进入终审，或是否需要补来源/修订。 |
| 来源补全与修订 | `sources_fix` | 为 `needs_fact_sources` 文章补证据、修订正文并重新核查；daily 补位循环会在来源门禁后优先触发它。 |
| 文章质量主评分 | `article_quality_score` | 用主评分判断文章是否达到质量门。 |
| SEO/GEO 辅助评分 | `seo_geo_score` | 给出搜索和 AI 引用友好度建议，不覆盖质量门。 |
| 渠道改写 | `channels_generate` | 为 ready 文章生成公众号、抖音、小红书等渠道稿。 |
| 发布包生成 | `package_export` | 整理正文、渠道稿、元数据和检查结果。 |
| 人工终审 | `review_mark` | 记录人工通过、退回、归档等动作。 |
| 运行摘要 | `db_list` | 读取最新文章状态，作为本次运行收尾。 |

生产入口：

```bash
cd workflow_py
uv run contentflow engine daily
uv run contentflow engine batch --limit 1 --target-ready 5
```

## Python Runtime

`workflow_py/contentflow` 是唯一 workflow runtime。

- `cli.py`：极薄入口，只启动 `commands.root.app`。
- `commands/`：Typer CLI 命令分组，暴露 `contentflow <domain> <action>`。
- `core/`：MySQL-only 连接、migration、配置读取、trace 审计。
- `flow/`：batch/daily 编排、run control、runtime 参数、step registry、LangGraph 图。
- `domains/sources/`：HTTP/RSS/page/AMZ123 采集、正文抽取、canonical ingest、source lanes。
- `domains/topics/`：素材选择、topic generation、source relevance、dedupe、audition。
- `domains/production/`：article_generation、factcheck、source resolution、quality、scoring、channels、package、review。
- `domains/taxonomy/`：内容分类。
- `llm/`：prompt 组装、模型调用审计、JSON/schema 校验、OpenClaw provider。
- `ops/`：engine report、配置同步、来源检查、关键词分析、canonical 回填。

## 开源库边界

基础能力优先用成熟库：

- CLI：Typer
- 配置：Pydantic Settings、python-dotenv、PyYAML
- MySQL：PyMySQL
- HTTP/RSS/HTML：httpx、feedparser、BeautifulSoup、trafilatura
- URL canonical：courlan
- 近似重复：rapidfuzz
- Schema 校验：jsonschema
- migration 拆分：sqlparse
- 重试：tenacity
- 编排图：LangGraph Python

项目内只保留业务规则：source lane、亚马逊电商来源守门、portfolio balancer、质量门禁、状态机、报告结构。

## Trace

每次 engine run 写：

- `engine_runs`：总体状态、统计、`summary_json`
- `workflow_steps`：步骤状态、耗时、输入/输出摘要
- `workflow_events`：细粒度事件
- `source_collection_logs`：每个采集源的采集结果
- `status_transitions`：状态变更审计
- `model_runs`：模型调用 prompt/raw_response/parsed/usage

trace 写入失败不应中断主流程；Python runtime 会把失败计入 warning/summary。

## Daily Run Control

- `daily_key = YYYY-MM-DD`
- 默认一天只有一个 active daily run。
- `start`：当天无 active run 才允许。
- `retry`：仅 failed/partial，可复用未完成写作任务。
- `rebuild`：归档旧 run 后重跑，不物理删除。
- `force`：创建额外 run，默认不抢 active。

Viewer / Web 触发时也应调用 Python `contentflow engine daily`，不要绕过 run control 直接写库。

## Source Lanes

三条 lane 按消费方式区分：

| Lane | 窗口 | 消费方式 |
|---|---|---|
| news | first_seen 72h 内 | 只看新的快讯/新闻线索 |
| policy | 7 天 | 官方/政策类，原地更新可 reactivated |
| knowledge | 长期累积 | unused 轮转消费，成文后标 used |

采集结果写 `source_observations`；canonical 素材写 `source_canonical_items` / `source_items`。同 URL 重复采集只增加 observation，不重复插 canonical source。

## Topic Generation

选题输入优先使用 `source_items.content_text` 截断片段，其次用 summary。topic generator 必须输出：

- topic/title
- primaryKeyword / secondaryKeywords
- contentType / businessCategory / topicCluster
- sourceUrls
- raw score
- content value score

来源守门要求候选来源必须直接支撑主题事实；非亚马逊电商来源会被压低或拒绝。

## Portfolio Balancer

选题不是“最高分直接胜出”：

```text
selection_score = content_value_score * 0.55
                + raw_score * 0.25
                + 组合奖励
                - 饱和/重复/来源弱惩罚
```

- 主题簇/业务分类硬配额优先。
- 高分但近期饱和/重复 → `deferred`，带 `deferred_until`。
- 低质/高风险/无业务价值 → `rejected`。
- 批内同 `topic_cluster` 不重复。
- 决策写 `portfolio_debug_json` 和 workflow events。

## 质量门

`article_quality_score >= 80` 是进入 `ready_for_review` 的主门禁。

优先级：

1. 事实可靠性
2. 文章质量主评分
3. SEO/GEO 辅助评分

SEO/GEO 低分只能给优化建议，不能覆盖质量不足。

## Topic Audition

```bash
cd workflow_py
uv run contentflow topic audition --rounds 10 --limit 3
```

模拟未来 N 轮选题，不生成文章。结果写 `topic_audition_runs/items`，用于判断分类覆盖、重复风险、平均价值分和候选池健康度。
