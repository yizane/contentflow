# 09 — Web Integration Contract

Web 项目**只通过 MySQL** 与本引擎通讯，不读本仓库任何本地文件。

## Web 可读表

文章消费：`articles`、`article_versions`、`channel_outputs`、`publish_packages`、`quality_reports`、`fact_checks`、`source_resolutions`、`seo_geo_scores`、`review_actions`

运行监控（Trace Console 同款数据）：`engine_runs`、`workflow_steps`、`source_collection_logs`、`workflow_events`、`status_transitions`、`model_runs`、`engine_reports`

Workflow 侧可观测性：`source_observations`、`source_canonical_items`、`topic_signals`、`topic_dedupe_records`

## 适合前端展示的字段

- articles：title/slug/status/quality_score/seo_score/geo_score/fact_publish_readiness
- article_versions：article_markdown（正文渲染）、version_label、strategy
- publish_packages：metadata_json、readme_markdown、channels_json、ready_for_publish_package
- workflow_steps：step_name/status/duration_ms/output_summary_json。`topics_select.output_summary_json` 的本轮写作任务数读 `writingTaskCount`；不要再读历史 `jobCount/jobsCount`。
- engine_reports.report_json.observability.steps：displayName/purpose/durationMs/modelCalls/inputTokens/outputTokens/totalTokens/round。前端展示主标题优先用 `displayName`；当前主链路 stepKey 为 `sources_collect`、`topics_generate`、`topics_select`、`articles_generate`、`articles_factcheck`、`seo_geo_score`、`channels_generate`、`db_list`。
- source_collection_logs：全字段（运维面板）
- workflow_events：event_type/level/message/created_at
- status_transitions：from/to/reason/actor/created_at
- model_runs：task_type/status/duration（started_at→finished_at）/error_message 摘要

## ⚠️ 不适合普通用户展示的字段

- `model_runs.task_prompt` / `model_runs.raw_response`（内部提示词与模型原始输出——管理端 debug 视图可用，需折叠+权限）
- internal error stack（error_message 只展示首行摘要）
- `source_resolutions.notes` 中的内部核查备注（编辑可见，访客不可见）

## 状态机（articles.status）

`article_validated → needs_fact_sources → ready_for_review → reviewed → approved_for_publish → published`
分支：`rejected` / `fact_check_failed` / `archived`。每次变更在 status_transitions 有审计。

## Run Control（Web 复用）

正式 Web 管理后台应复用：`engine_runs`（daily_key/run_scope/run_mode/is_active/superseded_by/triggered_by/trigger_source 字段）与 `run_actions` 表，以及"一天一个 active daily run"的判定逻辑（以 `workflow_py/contentflow/flow/run_control.py` 为准：start 仅当无 active；retry 仅 failed/partial；rebuild 归档不删除；force 默认不抢 active）。触发前先查 active run，拒绝时记 run_actions(status=rejected)。

Daily 成功口径读 `engine_runs.summary_json`：`targetReady`（默认 5）、`readyCount`、`attemptedWritingTasks`、`qualityFailedCount`、`businessOutcome`。`businessOutcome=target_met` 才表示日产目标达成；`partial/no_ready_articles` 是业务产出不足，不等同于进程崩溃；`technical_failed` 才表示技术失败。

历史模拟或补数触发需传 `--as-of-date YYYY-MM-DD`。Web 展示时应按 `daily_key` 与 started/finished/created_at 的模拟日理解数据，不要按真实执行日归档。

时间口径：所有 MySQL `DATETIME` 列按 UTC 存储；`engine_runs.daily_key` 是 Asia/Shanghai 的本地业务日。按日过滤时，Viewer 需把本地日边界换算成 UTC 区间。

## Config 管理（Web 可写）

Web 管理页可直接编辑：`config_keywords`、`config_sources`（CRUD + enabled 开关）、`app_configs`（prompts/schemas/策略文档；更新时 version+1、content_sha256 重算、updated_by='web'）。Python 引擎每个进程启动时加载一次配置，Web 修改在下一次 engine run 生效。注意：`schema:*` 与 prompt 修改影响生成质量，建议 Web 端保留版本历史与回滚。

## 内容分类字段（Phase 12）

Web 项目可直接按以下 MySQL 字段筛选与统计（**只读 MySQL，无需其他通道**）：

- `articles.content_type` / `articles.business_category` / `articles.topic_cluster`
- `topic_candidates` / `source_items` 同名字段（另含 `classification_confidence` / `classification_reason`）
- `publish_packages.metadata_json` 内含 `contentType` / `businessCategory` / `topicCluster`
- 分类过程与置信度：`content_classifications`（entity_type + entity_id 取最新一条）
- 中文标签 / 枚举定义：`app_configs` 的 `content_taxonomy`（YAML）

Viewer API 已支持：`GET /api/articles?content_type=X&business_category=Y&topic_cluster=Z`。

注意：`source_group` 是来源分组（采集渠道），不是内容分类，不要在 Web 上当作内容类别展示。

## 选题决策可解释字段（Phase 12B）

Web 展示「为什么选 A 不选 B」：`topic_candidates.raw_score / selection_score / selection_status / selection_skip_reason / deferred_until / portfolio_debug_json`（penalties/bonuses/similarity 明细）。组合健康度读 `engine_reports.report_json.portfolioHealth`。

## Source Observation / Topic Dedupe（Phase 14）

日报 source 计数以 `source_observations` 为准，不再用 `source_items.engine_run_id` 推断当天采集量：

- `source_observations`：每次 raw 采集观察一行，同 URL 重复出现也保留 observation；按 `engine_run_id` / `daily_key` 统计当天采集行为。
- `source_canonical_items`：canonical URL 身份、`first_seen_at`、`last_seen_at`、lane、knowledge `usage_status`、`times_in_prompt`。它是素材复用状态，不是每日采集明细。
- `source_items`：canonical 素材内容表；同 canonical URL 不重复插入多行，因此其 `engine_run_id` 可能是首次看到该素材的 run。
- `topic_signals`：机械解释某条 observation 是否被合并进候选、未被模型选择、或因重复候选被阻断。
- `topic_dedupe_records`：选题去重审计。`shadow_duplicate` 是 audit-only，不进入 `topic_candidates`，Viewer 候选列表不需要额外过滤这类记录。

`topic_candidates.status='deferred'` 仍表示临时不可选，`deferred_until` 到期后可回池。不要把 deferred 当作 rejected。

`engine_reports.report_json.sourceObservationCoverage` 与 `sourceLanes` 是 Viewer 可直接展示的摘要：

- `sourceObservationCoverage.newSources / seenSources / reactivatedSources / topicDedupeByDecision`
- `sourceLanes.news.fresh72h`
- `sourceLanes.policy.fresh7d / reactivated`
- `sourceLanes.knowledge.unused / used / oldestUnusedDays`

## Topic Audition API（Phase 12D）

- `GET /api/topic-auditions?limit=10`：压力测试运行列表（覆盖分类数 / Alexa 占比 / 平均价值分 / 重复风险 / 结论）
- `GET /api/topic-auditions/:id`：单次明细（summary.days 未来选题日历 + items 每轮决策）
- `POST /api/topic-auditions/run`（{rounds, limit}）：后台跑一次 audition，仅模拟选题不生成文章
- 价值分字段：`topic_candidates.content_value_score` / `value_breakdown_json`

## 文章质量与视觉规划字段（Phase 13）

- 主评分：`articles.article_quality_score`（>=80 才可终审）；明细 `article_quality_scores` 最新一条
- 视觉规划：`articles.visual_plan_json` / `article_versions.visual_plan_json`（说明、图注、替代文本、生图提示，无图片二进制）；Web 端按正文位置渲染占位或接生图
- 发布包：`publish_packages.visual_plan_json` + `article_quality_json` + metadata 统计字段
