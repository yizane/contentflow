# 05 — Database Model（MySQL 唯一数据源）

正式 schema：`db/mysql_schema.sql`（单文件，`npm run db:init` / `db:migrate` 幂等应用；未来需要增量演进时再建 `db/mysql_migrations/` 目录，runner 已支持）。

## 内容表

| 表 | 说明 | 正文/大字段 |
|---|---|---|
| articles | 文章主记录（状态机） | — |
| article_versions | 版本（v1/v2…） | **article_markdown** + article/quality/fact_check/source_resolution/seo/geo/dual JSON |
| channel_outputs | 渠道稿 | **content_markdown** + content_json |

`engine_runs.summary_json` 现在包含日产目标结果：`targetReady`、`maxAttempts`、`readyCount`、`attemptedJobs`、`qualityFailedCount`、`businessOutcome`（target_met / partial / no_ready_articles / technical_failed）。`articles_validated` 在 daily summary 中按 `ready_for_review` 数量回写。
| publish_packages | 发布包全量 | readme/article markdown + 全部 JSON + channels_json |
| quality_reports / fact_checks / source_resolutions / seo_geo_scores | 评审记录 | raw_json |
| model_runs | OpenClaw 调用 | **task_prompt / raw_response**（内部数据） + parsed_output_json |
| topic_candidates / article_jobs / source_items | 选题与采集 | raw_json |
| engine_runs / engine_reports / review_actions | 运行与审计 | report_markdown |

## Trace 表（migration 004）

| 表 | 用途 |
|---|---|
| workflow_steps | engine run 步骤明细（status/duration/input/output summary） |
| source_collection_logs | 每个源的采集结果（success/partial/failed/skipped） |
| workflow_events | 细粒度事件流（level: debug/info/warning/error） |
| status_transitions | 实体状态流转（entity_type + entity_id + from/to + reason + actor） |

## 历史说明

（SQLite 时代的 schema/migrations/数据文件已在 v1.0-rc1 清理中全部删除；数据已完整迁入 MySQL。）

## Config 表（Web 管理页编辑入口）

| 表 | 用途 |
|---|---|
| config_keywords | 关键词库（结构化，每行一词，enabled 开关） |
| config_sources | 采集源（结构化，每行一源） |
| app_configs | 文档型配置：internal_claims/production_policy/models/sources_yaml/keywords_csv + 全部 prompts + 全部 schemas（version/sha/updated_by） |

运行时一律读 DB（config_lib 进程级缓存）；仓库 config/、prompts/、schemas/ 文件为 seed，`npm run config:sync` 灌入 DB（updated_by != file-sync 的 Web 修改默认不覆盖，--force 才覆盖）。

## 内容分类字段（migration 006）

`source_items` / `topic_candidates` 增加：`content_type`、`business_category`、`topic_cluster`、`classification_confidence DECIMAL(5,4)`、`classification_reason TEXT`（均有索引）。

`article_jobs` / `articles` / `article_versions` 增加：`content_type`、`business_category`、`topic_cluster`（均有索引；置信度与原因查 `content_classifications`）。

新增 `content_classifications` 表（分类过程审计）：

- `entity_type` + `entity_id`：被分类实体（source_items / topic_candidates / articles）
- `content_type` / `business_category` / `topic_cluster` / `confidence` / `reason`
- `classifier_type`：rules（规则）/ openclaw（AI）/ topic_generation（选题直出）/ inherited（继承）
- `model_run_id`：AI 分类时关联 model_runs
- 同一实体可有多条记录（重分类历史），最新一条为当前生效来源

枚举值由 `config/content_taxonomy.yaml` 定义（app_configs key: `content_taxonomy`），分类可后续人工修正（当前只做自动分类）。

## Topic Portfolio 字段（migration 008）

`topic_candidates` 增加：`raw_score`（=score，质量分）、`selection_score`（组合选择分）、`selection_status`（eligible/selected/deferred/skipped_quota/skipped_duplicate/skipped_low_score/skipped_recent_keyword）、`selection_skip_reason`、`deferred_until`、`portfolio_debug_json`（扣分/加分明细）。

status 语义：`deferred` = 高分但近期主题饱和（窗口后回池，仍是好选题）；`rejected` = 低质量/事实风险/无业务价值（终态）。Web 展示选择原因直接读 `selection_skip_reason` + `portfolio_debug_json`。

## 内容价值分与 Audition 表（migration 009）

`topic_candidates` 增加 `content_value_score`（0-100，独立于 SEO/GEO）+ `value_breakdown_json`（六维细项 + reason）。
新增 `topic_audition_runs`（一次压力测试：rounds/limit/policy 快照/summary）与 `topic_audition_items`（每轮决策：decision = selected / deferred / skipped_quota / skipped_duplicate / skipped_low_value / skipped_low_source_support，含三种分数与 debug JSON）。

## 文章质量主评分与视觉规划（migration 010）

新增 `article_quality_scores`（每次评分一条：7 维细项 + recommendation + raw_json）。
`article_versions` 增加 `article_quality_json` / `article_quality_score` / `visual_plan_json`；`articles` 增加 `article_quality_score` / `visual_plan_json`；`publish_packages` 增加 `visual_plan_json` / `article_quality_json`，metadata_json 含 articleQualityScore / 视觉规划数量 / 必需视觉项 / 是否有视觉规划。
新文章状态 `needs_quality_revision`：主评分 < 80 被门禁拦下，修订后重评。
