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
