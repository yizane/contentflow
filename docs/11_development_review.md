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

## Phase 12 — Content Taxonomy & AI Classification

- 新增 `config/content_taxonomy.yaml`（10 content_types / 11 business_categories / 6 topic_clusters）+ migration 006。
- `scripts/taxonomy_lib.js`：taxonomy 解析、枚举校验/纠偏（cluster 与 category 不一致时置空）、规则分类器。
- `scripts/classify_lib.js` + `scripts/content_classify.js`：规则 confidence ≥ 0.85 直接采用，否则批量调 OpenClaw（content_classifier prompt + schema），结果写实体表 + content_classifications + workflow_events + model_runs。
- 主流程接入：采集后自动分类（AI 限额）、选题 AI 直出分类（schema 增 contentType/businessCategory/topicCluster，缺失回退规则不阻断）、job→文章→版本继承、发布包 metadata、engine_report 分类统计、db:list/db:show 筛选展示、Viewer 筛选与详情展示。
- 已知边界：批量 AI 分类单批 ≤ 30 条；规则无信号且 AI 不可用时该条保持未分类（engine_report 会提示回填命令）。

## Phase 12B — Topic Portfolio Balancer

- 诊断确认三层问题：选择器赢家通吃、关键词库 62% 集中（4 个分类挂零）、生成 prompt 优先方向偏置。
- `config/content_portfolio.yaml`（分类目标占比/簇配额/惩罚/奖励/defer 策略）+ migration 008 + `topic_portfolio_lib`。
- jobs_create 改组合选择；topic_generator 加组合多样性硬性要求；keywords.csv 50→114（再平衡后 keywords:analyze 告警清零）。
- 已知边界：deferred 回池后若仍饱和会再次 deferred；组合目标 share 基于近 14 天产出（样本少时欠代表奖励普遍生效，属预期冷启动行为）。

## Phase 13 — Article Quality First & Visual Planning

- 主评分（article_quality_evaluator，7 维）+ 终审门禁（pipeline gateReadyForReview / review_mark / Viewer 双守卫）；SEO/GEO 降为建议线。
- 视觉规划字段进 schema（生成与修订必须输出 ≥2），validate_data_lib 校验占位引用/altText/截图占位不造假；旧文不强改，修订时自动补全。
- 实证：两篇 95/86 质量门 + 88-95 SEO/GEO 的存量文章被主编评分打 76（重复 + 实操不足），全部被阻止通过终审——证明「SEO/GEO 不能覆盖质量不足」落地。
- 已知边界：评分对加法有 ±5 容差（以维度和为准）；评分失败时进入 `needs_quality_revision`，不得放行到终审。
