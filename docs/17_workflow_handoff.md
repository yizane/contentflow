# 17 — Workflow 开发交接（Claude → Codex）

> 自此文档起：**workflow 侧（流水线/引擎/库/工具/prompts/schemas/migrations）由 Codex 开发**；
> **Viewer 侧（view_server.js / ui_api_lib.js / webpage/）由 Claude 开发**。
> Codex 的运行时指南在仓库根 `AGENTS.md`（Codex CLI 自动加载）。

## 一、已完成的演进（Phase 11 → 13）

| Phase | 内容 | 关键产物 |
|---|---|---|
| 11 | Daily Run Control | run_control_lib：一天一个 active run，start/retry/rebuild/force |
| 12 | 内容三层分类 | content_taxonomy.yaml、classify_lib（规则+AI）、content_classifications 审计、migration 006/007 |
| 12（重构） | scripts 三层目录 + providers | pipeline/tools/lib、域_动作命名、模型执行器抽象（openclaw_cli 生产 + 4 预留） |
| 12B | Topic Portfolio Balancer | content_portfolio.yaml、selection_score、deferred 语义、关键词库 50→114、migration 008 |
| 12D | 选题压力测试 + 价值评分 | content_value_score（6 维）、topic:audition 模拟器、migration 009 |
| 13 | 文章质量主评分 + 视觉规划 | article_quality_score（7 维，>=80 门禁）、visualPlan、migration 010 |

## 二、核心心智模型

1. **三个评分各司其职**：
   - `content_value_score`（选题阶段）：这个题值不值得写
   - `article_quality_score`（成文阶段，主评分）：写出来的文章好不好——**唯一的终审门禁**
   - SEO/GEO（辅助）：好文章更容易被发现的手段，< 70 给建议，永不拦发布
2. **选题不是分数最高者胜**：selection = cv×0.55 + raw×0.25 + 组合奖惩；主题簇/分类硬配额优先于任何分数。
3. **deferred ≠ rejected**：时间窗问题（饱和/重复/来源弱）→ deferred 回池；质量问题 → rejected/低价值留池。
4. **一切决策可解释且入库**：portfolio_debug_json、selection_skip_reason、workflow_events、audition 表——Viewer 靠这些讲「为什么」。

## 三、踩过的坑（别再踩）

1. **时区**：DB DATETIME 是本地时间，`new Date().toISOString()` 是 UTC；服务端比较「今天」必须用 `rc.getDailyKey(new Date(v))`，不能 `slice(0,10)`。
2. **lib 移动目录后 ROOT 错位**：`path.resolve(__dirname, '..')` 类代码在移动文件时必须同步改层级。
3. **AI 输出加法误差**：维度和与总分允许 ±5，以维度和为准（validate_data_lib 已处理，新评分类输出照抄此模式）。
4. **python replace 全局替换**：同形代码片段在多个函数出现时会误注入（ui_api_lib 出过 aqRow 事故），改代码用唯一锚点。
5. **dry-run 必须关连接池**，否则进程不退出（engine_batch 修过）。
6. **中文 Jaccard**：2-gram 对「换说法的同主题」不敏感（实测 0.36），语义重复要靠 topic_cluster 配额兜底，别指望调阈值。
7. **schema 加 required 字段会让旧 prompt 输出校验失败**：分类/价值分字段当时用「缺失回退 + warning」的软着陆，新字段照此办理。

## 四、运行状态快照（交接时）

- 文章 4 篇（2 篇 ready_for_review 但主评分 76 被终审守卫拦下、2 篇 needs_fact_sources）
- 候选池：新关键词库生成的多分类候选 ~40 个（含价值分），23 个 Alexa 系 deferred 至 2026-06-20
- 最近 audition：20 天模拟覆盖 8 分类、Alexa/Listing 14.3%、平均价值 86、判定「✅ 可以开始生成」
- 未分类 source_items 约 970 条（分批回填中）
- engine:daily 今日（06-06）未跑

## 五、Backlog 与验证清单

见 `AGENTS.md`（含优先级排序的 8 项 backlog 与回归命令）。任何 workflow 改动后的最小回归：

```bash
for f in scripts/**/*.js; do node --check "$f"; done   # 语法
npm run db:ping && npm run db:migrate                  # 数据层
node scripts/engine_batch.js --limit 1 --dry-run       # 编排不破坏
npm run jobs:create -- --limit 1 --dry-run             # 选题链路
PORT=5178 node scripts/view_server.js &                # Viewer 能起、bootstrap 200
curl -s localhost:5178/api/ui/bootstrap | head -c 50; kill %1
```

## 六、Viewer 契约（Codex 改 workflow 时的边界）

Claude 的 Viewer 依赖以下形状，**变更必须在交付说明中列出**：

- 表与字段：`articles`（含 article_quality_score / visual_plan_json / 分类三字段）、`topic_candidates`（selection_* / deferred_until / value 字段）、`topic_audition_runs/items`、`article_quality_scores`、`content_classifications`、`workflow_steps`（step_key 枚举）、`publish_packages`（metadata_json 键）
- `engine_reports.report_json`：qualityOverview / portfolioHealth / taxonomySummary 结构
- 状态枚举：articles.status（含 needs_quality_revision）、topic_candidates.status（含 deferred）、selection_status 集合

反向同理：Claude 不改 `scripts/pipeline|tools|lib`（ui_api_lib 除外）、`prompts/`、`schemas/`、`config/`、migrations；Viewer 需要新数据时由 Claude 在 ui_api_lib 内用只读 SQL 实现，或向 Codex 提字段需求。
