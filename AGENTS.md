# AGENTS.md — Codex 工作指南（flyfus-content-agent）

> 你（Codex）负责 **workflow 侧**（内容生产流水线/引擎/工具/库）的后续开发。
> **Viewer 侧由 Claude 负责**：`scripts/view_server.js`、`scripts/lib/ui_api_lib.js`、`webpage/` 三处**不要改**；
> 如果 workflow 改动影响这三处依赖的数据形状（表结构/字段语义/step_key），在交付说明里明确标注，由 Viewer 侧跟进适配。
> 详细交接文档见 `docs/17_workflow_handoff.md`，开发约定见 `docs/07_development.md`。

## 系统一句话

MySQL-only 内容生产引擎：采集 → 选题（组合平衡 + 价值评分）→ 生成 → 事实核查/补源修订 → 渠道改写 → SEO/GEO 评分 → 发布包 → 人工终审。模型调用经 `scripts/lib/providers/` 抽象层（生产路径 openclaw_cli）。

## 目录与命名（严格遵守）

```
scripts/
├── pipeline/   # 工作流步骤 CLI，命名 域_动作.js ↔ npm 域:动作（jobs_run.js ↔ jobs:run）
├── tools/      # 人工运维命令（db_*/config_sync/sources_check/keywords_analyze）
├── lib/        # 内部库 *_lib.js + providers/；ROOT = path.resolve(__dirname,'..','..')
└── engine_daily / engine_batch / engine_report / view_server（编排与服务）
```

- 不留旧命名别名；`workflow_steps.step_key` 与文件名同一套命名（改名要写数据迁移）。
- 一次性检查/调试**不要**加脚本——用临时 `node -e`；tools/ 必须有被流水线/文档/运维引用的理由。

## 硬性红线

1. **MySQL 是唯一运行时数据源**：不落本地 output 文件、不 fallback SQLite、所有结果/trace/决策写库。
2. **不破坏** `engine:daily` / `engine:batch` / Run Control / Viewer；改动后必跑 `node scripts/engine_batch.js --limit 1 --dry-run`。
3. **质量优先级**：article_quality_score（主评分）>= 80 才能进 ready_for_review > 事实可靠性是底线 > SEO/GEO 只是建议线，永远不能覆盖前两者。
4. **选题语义**：高分但近期主题饱和 → `deferred`（带 deferred_until，窗口后回池）；`rejected` 仅用于低质/高风险/无业务价值。
5. **分类体系**：source_group（来源）≠ content_type/business_category/topic_cluster（内容三层分类，config/content_taxonomy.yaml）。
6. 不自动生成图片、不把二进制放数据库；视觉规划只存说明、图注、替代文本、生图提示等规划信息。
7. 不接 Strapi/Cron、不调用 Flyfus MCP、不真实发布文章。
8. migration 编号顺延（已到 010），用 `npm run db:migrate` 执行（schema_migrations 追踪）。
9. 配置改动（config/ prompts/ schemas/）后运行 `npm run config:sync` 入库才生效。

## 常用命令

```bash
npm run db:ping / db:migrate / db:list -- --with-scores
npm run engine:daily [-- --mode retry|rebuild]      # 幂等：一天一个 active run
npm run engine:batch -- --limit 1 --dry-run         # 改动后的回归检查
npm run topic:audition -- --rounds 10 --limit 3     # 选题压力测试（不生成文章）
npm run score:article-quality -- --status ready_for_review
npm run keywords:analyze / sources:check / config:sync
npm run engine:report                                # 含 qualityOverview / portfolioHealth
```

## 当前 backlog（按优先级）

1. **跑通第一篇质量合格文章**：存量两篇主评分 76 被拦；跑 `npm run sources:fix` 触发修订（会按 mustFix 差异化改写 + 自动补视觉规划 + 重评分），或走 engine:daily 生成新文验证全链路。
2. 历史 source_items 分类回填剩余 ~970 条：`npm run content:classify -- --entity source_items --limit 500` 分批。
3. 渠道改写支持单渠道重试（现在失败只能整批重跑）。
4. 采集噪声治理：community_signals 的导航类条目（"Subscribe Now" 等）在 collect 阶段过滤超短标题。
5. brand_growth / ai_tools / marketplace_policy 候选为 0：补 1-2 个站外营销/工具类采集源（sources.yaml），不是关键词问题。
6. `--strategies` 同题多策略并行生成（jobs_create 里 P2 TODO）。
7. providers/openclaw_gateway 协议确定后实现；codex_cli/claude_cli 执行器标实验性待验证。
8. deferred 候选到期回池后的自动复检节奏（目前依赖下次 jobs:create 触发）。
9. **主题→数据源 ID 关联未落库**：`topic_candidates.source_item_ids_json` 全部是 `[]`（109/109），
   只有 `source_urls_json` 有值。topics_generate 时应把候选引用的 source_items 主键写进
   source_item_ids_json，Viewer 才能从主题直接钻取到具体数据源条目（URL 串无法 join）。
10. **新闻快讯断层**：source_items 里 news_flash 有 50 条，但 topic_candidates 里 news_flash≈0、
   articles 里为 0——新闻类资讯采进来了却几乎不产出主题。确认是 topic_generator prompt 偏好
   还是选题打分压制，属于结构性偏置（参照 12B 的主动报告要求）。

## 与 Viewer 的契约

Viewer 只读以下数据形状，变更需在交付说明标注：
- **模拟/回填数据的时间戳契约（重要）**：模拟「最近 N 天」的数据生成时，每条数据的 `created_at`
  （source_items / topic_candidates / articles / article_versions / fact_checks / channel_outputs /
  status_transitions / workflow_events）和 `engine_runs.daily_key` + `started_at/finished_at`
  **必须回填到对应的模拟日**，不能全部落在执行当天——Viewer 的「生产日报」按天聚合
  （`/api/ui/days`、`/api/ui/day/:date`），时间戳糊在一天会让按天调试失效。
- 表字段：articles / topic_candidates / topic_audition_* / article_quality_scores / content_classifications / workflow_* / publish_packages
- `workflow_steps.step_key` 集合（监控台 7 步映射）
- `engine_reports.report_json` 的 qualityOverview / portfolioHealth 结构
