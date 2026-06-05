# 03 — Workflow

## 主流程（engine:daily / engine:batch）

```
collect_sources → topic_generation → create_article_jobs → article_generation
→ fact_check → (source_fix 按需) → channel_repurpose → seo_geo_score
→ export_package → engine_report
```

## Workflow Trace（全部写 MySQL）

每次 engine run：

- `engine_runs` 一条主记录（总体统计在 summary_json）
- 每个大步骤一条 `workflow_steps`（status: pending/running/success/warning/failed/skipped，duration_ms 自动计算）
- 细粒度事件写 `workflow_events`（engine_started / step_started / step_completed / source_fetch_* / topic_candidate_* / article_job_created / openclaw_call_* / validation_failed / status_changed / package_created / engine_completed）
- 每个采集源一条 `source_collection_logs`（含 http_status / items_found / items_inserted / duration_ms / sample_titles）
- 所有状态变更写 `status_transitions`（article / article_version / article_job / topic_candidate / channel_output / publish_package）

子进程通过环境变量 `ENGINE_RUN_ID` / `WORKFLOW_STEP_ID` 关联到当前 run 与 step。

trace 写入失败不会中断主流程（计数 + console.warn），engine run summary_json 的 `traceFailures` 字段与 engine_report 会提示。

## Daily Run Control（Phase 11）

- 每天一个主键 `daily_key = YYYY-MM-DD`，**默认一天只有一个 active daily run**（应用层在 run_control_lib.canStartDaily 控制；未加 DB 唯一约束——is_active 为 TINYINT，唯一约束会阻止多条历史 inactive 记录）。
- 模式：`start`（无 active run 才允许）/ `retry`（仅 failed/partial；复用当天未完成 job，跳过已成功数据）/ `rebuild`（归档旧 run 后完整重跑）/ `force`（高级：额外 run，默认 is_active=false，`--make-active` 才接管）。
- rebuild **不物理删除**：旧 run → superseded；topic_candidates → archived；pending/failed job → cancelled；非 approved/published 文章及其版本/包/渠道 → archived/superseded；approved_for_publish/published **不自动归档**，输出 warning。全程写 status_transitions。
- 所有触发（CLI/Viewer）写 `run_actions`（accepted/rejected/running/success/failed）。
- engine:batch 不参与 daily 唯一性（run_scope=batch）。

## 内容分类（Phase 12：Content Taxonomy & AI Classification）

三层分类体系（定义在 `config/content_taxonomy.yaml`，经 `config:sync` 入库）：

| 层 | 字段 | 含义 | 示例 |
|---|---|---|---|
| 来源分组 | `source_group` | 它从哪里来（**不是**内容分类） | official_amazon / chinese_crossborder_news |
| 内容形态 | `content_type` | 它是什么内容 | operation_guide / policy_update / risk_warning |
| 业务主题 | `business_category` | 它属于哪个运营板块 | listing_geo / ppc_acos / amazon_ai_shopping |
| 主题簇 | `topic_cluster` | 它在什么内容专题里 | rufus_question_data / listing_semantic_structure |

分类流程：

1. **规则分类**（`taxonomy_lib.classifyByRules`）：标题/摘要关键词 + source_group 先验；confidence ≥ 0.85 直接采用。
2. **AI 分类**（OpenClaw `content_classifier`，批量）：规则低置信时兜底；中文源**不会**只因语言被归为 news_flash。
3. 结果写入实体表字段（source_items / topic_candidates / article_jobs / articles / article_versions）+ `content_classifications` 审计表（含 confidence / reason / classifier_type / model_run_id）。

接入点：

- `collect:sources` 采集后自动分类（AI 限额 3 批，剩余由 classify:content 回填）；
- `run:topic-generation` 输出 contentType/businessCategory/topicCluster（继承或修正 source 分类），缺失回退规则；
- `jobs:create-articles` → `article_jobs` 透传分类 → 文章/版本入库时落字段；
- 修订版本沿版本链继承分类；
- `export:package` 的 metadata_json 含 contentType/businessCategory/topicCluster；
- `engine:report` 输出 contentTypeCounts / businessCategoryCounts / topicClusterCounts、source 多但文章少的类别、按业务分类的待补来源积压。

回填命令：`npm run content:classify -- --all --limit 500`（支持 `--entity`、`--force`、`--no-ai`、`--max-ai-calls`）。
