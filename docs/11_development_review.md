# 11 — Development Review（Phase 10 备忘）

## Phase 10 交付

- migration 004：workflow_steps / source_collection_logs / workflow_events / status_transitions
- `scripts/trace_lib.js`：统一 trace 写入（失败计数不崩主流程）
- 主流程接入：engine_batch 步骤化（含 skipped 步骤）、collect 按源记日志、callAgent 事件、全状态流转入 status_transitions
- Viewer（本地只读）从零构建：`npm run viewer` → Articles / Engine Runs / Sources / Reports 四 tab + trace API

## 设计决定

- schema 已合并为单文件 db/mysql_schema.sql（24 表）；migration 目录在 v1.0-rc1 清理中移除，db_migrate.js 保留增量机制
- Viewer 绑定 127.0.0.1，默认不返回 prompt/raw_response 全文（只给 CHAR_LENGTH 摘要）；文章正文在折叠区展示（本地调试工具可接受）
- trace 失败策略：吞错 + 计数，engine summary_json.traceFailures 与 report 提示

## 已知 TODO

- review_mark 的 status_transitions 在 dry-run 时只写 review_actions(dry_run=1)，不写 transitions（按需）
- run_seo_geo_score / fix_sources 单独 CLI 运行时（无 engine run 上下文）事件的 engine_run_id 为 NULL——Web 端按 related_id 查询即可
- 多模型并行 / `--strategies` 仍为 P2
- legacy 文件型脚本（mvp 全家、build:*-task、文件型 validate:*）待清理

## Phase 11 交付

- migration 005：engine_runs +7 字段（含历史 backfill：旧 daily run 按启动日期归 daily scope）+ run_actions 表
- run_control_lib：getDailyKey / getTodayRunStatus / canStartDaily / recordRunAction / markRunSuperseded / archiveRunData
- engine_daily 四模式 + --plan-only；engine_batch 接 --run-id 等控制参数；retry 复用当天未完成 job
- Viewer：Run Control 面板（按钮按 availableActions 启停，rebuild 需 confirm，force 不做 UI 入口）+ runs 列表 badges + run detail 显示 run_actions/transitions
- Generate Report 按钮 v1 仅提示 CLI 命令（保持 Viewer 写操作面最小）；后续可加 POST /api/run-control/report
