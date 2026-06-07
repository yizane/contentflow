# 12 — v1.0-rc1 Acceptance Report

> 验收日期：2026-06-05　|　版本：**v1.0-rc1**（package.json 1.0.0-rc.1）

## 1. 版本定义

Flyfus Content Generation Engine v1.0-rc1：MySQL-only runtime 的内容生成引擎。Web 为独立项目，仅通过 MySQL 通讯。真实发布不在本项目内。

## 2. 已完成功能

采集（42 源：RSS/Atom/页面/搜索）→ 主题池（去重+节流）→ 文章生成（三策略/重试/slug 唯一）→ 质量门 → 事实核查 → fix:sources 修订闭环（internal claims 白名单）→ SEO/GEO 双评分（事实优先）→ 三渠道改写 → 发布包 → 人工终审标记 → 生产报告 → 全链路 trace → Daily 幂等控制 → 本地 Viewer（5 tabs + Run Control）。

## 3. 核心命令（22 个）

`db:ping/init/migrate/list/show`、`engine:daily/batch/report`、`collect:sources`、`run:topic-generation`、`jobs:create-articles/run-articles/run-fact-check`、`channels:generate`、`fix:sources`、`run:source-resolution/article-revision/seo-geo-score`、`export:package`、`review:mark`、`check:sources`、`viewer`。

## 4. MySQL 表（21）

内容 11：articles, article_versions, article_jobs, topic_candidates, source_items, quality_reports, fact_checks, source_resolutions, channel_outputs, seo_geo_scores, publish_packages
运行 6：engine_runs, model_runs, engine_reports, review_actions, run_actions, schema_migrations
trace 4：workflow_steps, source_collection_logs, workflow_events, status_transitions

## 5. Viewer（127.0.0.1，本地开发控制台）

Articles（详情+Trace）/ Engine Runs（步骤时间线+badges）/ Sources（采集明细筛选）/ Reports + Run Control 面板（Run/Retry/Rebuild 按 availableActions 启停）。API 13 个；prompt/raw_response 只给字符数。

## 6. OpenClaw 链路

prompt_lib 内存组装 → `openclaw agent --message --json` → extractJson → validate_data_lib → MySQL。每次调用 model_runs（prompt/raw_response/parsed）+ workflow_events。OpenClaw 仅执行层。依赖本机配置：searxng（json 格式开启）、web_fetch fake-IP 放行、flyposter-ai provider。

## 7. Daily 幂等

一天一个 active daily run（daily_key）；start 仅当无 active；retry 仅 failed/partial（复用未完成 job）；rebuild 归档不删除（approved/published 受保护）；force 默认不抢 active；全部触发记 run_actions。

## 8. 已知 Legacy

首次 git 提交前已全部物理删除：SQLite 文件（数据已完整迁入 MySQL 并验证）、legacy/output 历史产物、22 个文件型/SQLite 脚本、迁移工具。仓库只剩 MySQL-only runtime 代码。DB 内旧 artifacts 表保留为历史数据（Web 不读）。

## 9. 已知风险

1. **单 LLM provider**（flyposter-ai）无 failover；代理节点抖动直接断链（trace 有记录，重跑可恢复）
2. RDS 密码曾在对话明文出现，**用户选择暂不轮换**——建议试运行前轮换
3. 部分官方页 web_fetch 受反爬限制 → fact check 偏保守（needs_manual_review）
4. 迁移自 SQLite 的旧 model_runs 无 article_id 关联
5. Agent 输出 JSON 偶发算术/格式错误——校验器可拦截，重试可恢复，但消耗调用
6. 渠道/评分对超长文章未测边界（当前 5-8k 字正常）

## 10. 7 天试运行计划

- 每日：Viewer 点 Run Today（或 `npm run engine:daily`）→ 看 report → fix:sources 清 needs → 终审 ready 文章（review:mark）
- 每日检查：source_collection_logs failed 是否新增类型、model_runs failed、traceFailures
- 第 3/7 天：engine:report 对比平均 SEO/GEO 分趋势、dedupeRejected 是否上升（主题池枯竭信号）
- 记录人工终审耗时，作为 v1.1 优化输入

## 11. 不建议继续开发

Strapi/CMS 对接（Web 项目职责）、Cron（外部调度即可：cron 调 `npm run engine:daily`，幂等已保证）、Viewer 加更多写操作、OSS/文件存储回退。

## 12. v1.1 候选

多模型并行 + selected_as_final（--strategies 已留参数）、provider failover、fix:sources 自动多轮（带收敛检测）、主题池补水策略（dedupeRejected 高时自动扩 source）、人工终审 UI（Web 项目）、发布对接（Web 项目）。

## 结论

**v1.0-rc1 验收通过，可进入 7 天试运行。**
