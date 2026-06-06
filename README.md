# Flyfus Content Agent

面向中国亚马逊卖家的 **SEO/GEO 内容生成引擎**（v1.0-rc1）。自动完成：选题源采集 → 主题池 → 文章生成 → 质量门 → 事实核查 → 来源修订 → 三渠道改写 → SEO/GEO 双评分 → 发布包。

- **MySQL 是唯一 runtime source of truth**——所有正文、JSON、trace、审计都在库里
- **Web 是独立项目**，只通过 MySQL 与本引擎通讯，不读本仓库任何文件
- **OpenClaw 是执行层**（LLM 调用），不是状态库；prompt/raw_response 落 `model_runs`，属内部数据
- **真实发布不在本项目内**——产出止于 `publish_packages` + 人工终审标记

## 快速开始

```bash
git pull && npm install
cp .env.example .env        # 填 MySQL 连接（.env 不进 Git）
npm run db:ping
npm run db:init && npm run db:migrate
npm run engine:daily        # 每日 1 篇（幂等：一天一个 active run）
npm run viewer              # 本地控制台 http://127.0.0.1:5177
```

依赖：Node ≥18、MySQL 8.x、本机 OpenClaw（searxng search provider + web_fetch fake-IP 放行，见 docs/06）。

## Runtime Data Model

Runtime 数据全部在 MySQL（21 表）：

- 内容：`articles`、`article_versions`（正文 `article_markdown` + 全部 JSON）、`channel_outputs`、`publish_packages`、`quality_reports`、`fact_checks`、`source_resolutions`、`seo_geo_scores`、`topic_candidates`、`article_jobs`、`source_items`
- 运行：`engine_runs`、`model_runs`（含 prompt/raw_response，内部数据）、`engine_reports`、`review_actions`、`run_actions`、`schema_migrations`
- 分类：`content_classifications`（分类过程审计；实体表自带 content_type / business_category / topic_cluster 字段）
- Trace：`workflow_steps`、`source_collection_logs`、`workflow_events`、`status_transitions`

本仓库只存代码与静态配置（`config/`、`prompts/`、`schemas/`、`db/`、`scripts/`（pipeline / tools / lib 三层）、`webpage/`、`docs/`）。

## 日常操作

```bash
npm run engine:daily                                   # start；已完成会被拒绝
npm run engine:daily -- --mode retry                   # 仅 failed/partial 可用
npm run engine:daily -- --mode rebuild                 # 归档旧数据后重跑（不物理删除）
npm run sources:fix -- --limit 5                       # needs_fact_sources → ready_for_review
npm run channels:generate -- --status ready_for_review --missing-only
npm run package:export -- --status ready_for_review --with-channels
npm run review:mark -- --article-id <id> --status approved_for_publish
npm run engine:report
npm run db:list -- --with-scores
npm run content:classify -- --all --limit 100         # 内容分类回填（规则 + AI）
npm run topic:audition -- --rounds 10 --limit 3        # 选题压力测试：模拟未来 N 轮选什么（不生成文章）
npm run keywords:analyze                               # 关键词库分布体检
npm run db:list -- --business-category listing_geo     # 按业务分类筛选
npm run score:article-quality -- --status ready_for_review  # 文章质量主评分（>=80 才能进终审）
```

## Daily Run Control

一天默认只有一份 active daily run（`daily_key`）。重复执行 `engine:daily` 不产生脏数据；重跑用 `--mode retry`（只补失败）或 `--mode rebuild`（归档后重跑，approved/published 文章受保护）。Viewer 的 Run Today / Retry / Rebuild 按钮走同一套控制，所有触发记录在 `run_actions`。

## Viewer（本地开发控制台）

`npm run viewer` → http://127.0.0.1:5177（只绑本机）。Articles / Engine Runs / Sources / Reports 四个 tab + 顶部 Run Control 面板。只读 + 触发运行两类操作；默认不展示完整 prompt/raw_response。正式 Web 管理后台是独立项目，复用同一套 MySQL 表（契约见 docs/09）。

## 内容分类（Content Taxonomy）

三层分类，**source_group（来源分组）≠ content_type（内容分类）**：

- `content_type`：内容形态（新闻快讯 / 平台政策 / 运营干货 / 风险警示 …，共 10 类）
- `business_category`：业务主题（Listing GEO / 广告 PPC / 选品 / 账号合规 …，共 11 类）
- `topic_cluster`：主题簇（更细的内容专题，共 6 簇，归属于某个 business_category）

定义在 `config/content_taxonomy.yaml`；选题采用 **Topic Portfolio Balancer**（`config/content_portfolio.yaml`）：selection_score = 质量分 − 主题饱和惩罚 + 组合奖励，高分但近期重复的选题 deferred 回池而非拒绝，杜绝「最高分赢家通吃」；采集内容、选题、文章统一使用；分类 = 规则（confidence ≥ 0.85 直接采用）+ OpenClaw AI 兜底，结果连同 confidence/reason 写 MySQL（`content_classifications` 审计）。中文源不会只因语言被归为新闻快讯。分类可后续人工修正，当前只做自动分类。Web 项目直接按这些字段筛选。

## Web Integration

Web 项目推荐读取：`articles`、`article_versions`、`quality_reports`、`fact_checks`、`source_resolutions`、`channel_outputs`、`publish_packages`、`engine_reports`、`review_actions`，以及 trace 四表与 `run_actions`。不应向普通用户展示：`model_runs.task_prompt` / `raw_response`、内部 error stack。详见 `docs/09_web_integration_contract.md`。

## 文档

`docs/01_requirements.md` … `docs/12_v1_acceptance_report.md`（需求、架构、工作流、prompt 地图、数据模型、运维排查、开发约定、质量体系、Web 契约、验收清单、开发评审、v1 验收报告）。

## 内容铁律

1. 事实优先：无来源数字不写成事实；不确定信息降级表达
2. Amazon/Google 官方事实只认官方域名来源；中文行业源仅作选题线索
3. Flyfus 能力以 `config/internal_claims.yaml` 白名单为准；禁止承诺排名/推荐/ACoS
4. 正文零 AI 工作流痕迹
5. 命名口径：Amazon AI Shopping / Alexa for Shopping（Rufus 为历史名称与数据来源）

## 边界

不做 Web UI（Viewer 仅本地调试）、不接 Strapi、不内置 Cron（外部调度直接调 `engine:daily`，幂等已保证）、不调用 Flyfus MCP、不真实发布、无 ORM、无本地文件运行时状态。
