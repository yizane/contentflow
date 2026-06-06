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

## Topic Portfolio Balancer（Phase 12B）

选题逻辑从「谁分最高选谁」变为「**谁在当前内容组合里最值得选，选谁**」：

- `raw_score`：AI 对选题质量的评分（topic_score 产出，不考虑重复度）
- `selection_score = raw_score − 饱和惩罚 + 组合奖励`（`config/content_portfolio.yaml`）
  - 惩罚：主题簇/业务分类饱和、关键词 14 天内已用、标题/选题语义相似（中文 2-gram Jaccard 双通道）
  - 奖励：欠代表业务分类、PPC/选品/意图词专项、首篇主题簇、P0 契合、时效型内容
- **硬配额优先于 raw_score**：簇配额（默认 14 天 1 篇 / 30 天 2 篇）、分类配额（7d/14d 上限）触顶 → 候选 **deferred**（写 `deferred_until`，窗口期后自动回池），**不是 rejected**（rejected 仅用于低质/高风险/无业务价值）
- 批内多样性：limit > 1 时同 topic_cluster 不重复
- 每个决策（扣分/加分/跳过原因）写 `topic_candidates.portfolio_debug_json` + `workflow_events`（topic_candidate_selected / skipped_quota / skipped_duplicate），dry-run 可解释输出，监控台「组合决策」面板可见
- 生成侧约束：topic_generator 要求每批候选覆盖 ≥4 个业务分类，AI Shopping + Listing GEO ≤ 40%
- 关键词库体检：`npm run keywords:analyze`（占比/P0 分布/认知型词告警）

## 内容价值分与 Topic Audition（Phase 12D）

**质量优先**：文章质量优先级高于 SEO/GEO。`content_value_score`（满分 100，SEO/GEO 不参与）判断「值不值得写」：
sellerPainValue 20 / actionability 20 / informationGain 20 / businessFit 15 / nonRepetition 15 / sourceSupport 10。

最终选择公式：`selection_score = content_value_score × 0.55 + raw_score × 0.25 + 组合奖励 − 饱和惩罚`。
门槛：价值分 < 75 不选（skipped_low_value，留池）；痛点+可执行性 < 22 不选；来源支撑 < 4 defer。
新生成候选由 topic_generator 直接输出价值分；存量候选由 `ensureValueScores` AI 批量补分（启发式兜底）。

**Topic Audition（选题压力测试）**：`npm run topic:audition -- --rounds 10 --limit 3 [--refresh-candidates] [--json]`
模拟未来 N 轮选题（真实文章窗口滑动 + 模拟选中累积 + deferred 到期回池），不生成文章。
回答：未来会写什么 / 分类是否均衡 / 有没有用 / 有没有重复 / 哪些缺口 / 能否开始生成。
结果写 `topic_audition_runs` / `topic_audition_items`，Viewer 选题池页与 GET /api/topic-auditions 可见。

## 文章质量主评分 + 视觉规划（Phase 13）

**主从关系**：`article_quality_score`（主评分，7 维满分 100）>= 80 才能进 ready_for_review；SEO/GEO 降为建议线（< 70 给优化建议但不拦发布）；事实可靠性仍是底线。质量分不足时事实核查会把文章导向 `needs_quality_revision` 而非终审；review_mark / Viewer 终审同样有守卫。

评分维度：sellerPainFit 20 / actionability 20 / informationGain 20 / originality 10 / clarity 10 / evidenceUse 10 / businessUsefulness 10。类型特判：趋势类必须写卖家操作影响；干货类必须有步骤/清单；快讯必须有卖家影响+下一步。

**视觉规划**：文章生成/修订必须输出 ≥2 个视觉规划，包含位置、类型、标题、用途、说明、图注、替代文本、生图提示和是否必需；正文插 `> [配图建议 visual_N：…]` 占位。系统只存规划不生成图片、不存二进制；操作指南配流程图或清单卡，趋势解读配对比图或关系图。Viewer 详情页「视觉规划」Tab 可逐条查看并复制生图提示。

命令：`npm run score:article-quality -- --status ready_for_review | --article-id <id> [--force]`
