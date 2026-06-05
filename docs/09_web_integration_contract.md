# 09 — Web Integration Contract

Web 项目**只通过 MySQL** 与本引擎通讯，不读本仓库任何本地文件。

## Web 可读表

文章消费：`articles`、`article_versions`、`channel_outputs`、`publish_packages`、`quality_reports`、`fact_checks`、`source_resolutions`、`seo_geo_scores`、`review_actions`

运行监控（Trace Console 同款数据）：`engine_runs`、`workflow_steps`、`source_collection_logs`、`workflow_events`、`status_transitions`、`model_runs`、`engine_reports`

## 适合前端展示的字段

- articles：title/slug/status/quality_score/seo_score/geo_score/fact_publish_readiness
- article_versions：article_markdown（正文渲染）、version_label、strategy
- publish_packages：metadata_json、readme_markdown、channels_json、ready_for_publish_package
- workflow_steps：step_name/status/duration_ms/output_summary_json
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

正式 Web 管理后台应复用：`engine_runs`（daily_key/run_scope/run_mode/is_active/superseded_by/triggered_by/trigger_source 字段）与 `run_actions` 表，以及"一天一个 active daily run"的判定逻辑（参照 scripts/run_control_lib.js：start 仅当无 active；retry 仅 failed/partial；rebuild 归档不删除；force 默认不抢 active）。触发前先查 active run，拒绝时记 run_actions(status=rejected)。

## Config 管理（Web 可写）

Web 管理页可直接编辑：`config_keywords`、`config_sources`（CRUD + enabled 开关）、`app_configs`（prompts/schemas/策略文档；更新时 version+1、content_sha256 重算、updated_by='web'）。引擎每个进程启动时加载一次配置（config_lib 缓存），Web 修改在下一次 engine run 生效。注意：`schema:*` 与 prompt 修改影响生成质量，建议 Web 端保留版本历史与回滚。

## 内容分类字段（Phase 12）

Web 项目可直接按以下 MySQL 字段筛选与统计（**只读 MySQL，无需其他通道**）：

- `articles.content_type` / `articles.business_category` / `articles.topic_cluster`
- `topic_candidates` / `source_items` 同名字段（另含 `classification_confidence` / `classification_reason`）
- `publish_packages.metadata_json` 内含 `contentType` / `businessCategory` / `topicCluster`
- 分类过程与置信度：`content_classifications`（entity_type + entity_id 取最新一条）
- 中文标签 / 枚举定义：`app_configs` 的 `content_taxonomy`（YAML）

Viewer API 已支持：`GET /api/articles?content_type=X&business_category=Y&topic_cluster=Z`。

注意：`source_group` 是来源分组（采集渠道），不是内容分类，不要在 Web 上当作内容类别展示。
