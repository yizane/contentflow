# 17 — Workflow Handoff

当前状态：workflow 已从 Node 迁移到 Python。Node workflow、Node pipeline、Node graph runner、Node provider 和 root npm 兼容入口已删除。

## 分工边界

| 范围 | 负责 | 说明 |
|---|---|---|
| Workflow | Codex | `workflow_py/`、`config/`、`prompts/`、`schemas/`、`db/`、workflow docs |
| Viewer | Claude/用户指定 | `webpage/` |

Viewer / Web 触发 workflow 时直接执行 Python CLI：`uv run contentflow ...`。

## 当前 Python 能力

- batch/daily 编排与 daily run control
- source collection：HTTP/RSS/page、AMZ123 API、canonical ingest、source observations
- topic generation：source scope、正文片段输入、dedupe、source relevance
- portfolio balancer：selection_score、quota、deferred、debug json
- article generation、factcheck、source resolve/fix、revision
- SEO/GEO score、article quality score
- channels、package export、review mark
- content classify、topic audition、engine report
- db ping/init/migrate/list/show、sources check、keywords analyze、config sync

## 最小回归

```bash
cd workflow_py
uv run pytest
uv run contentflow engine batch --limit 1 --dry-run
uv run contentflow sources check
uv run contentflow keywords analyze
```

## 需要继续关注

1. 每日目标是 `ready_for_review` 文章数，不是生成任务数。
2. 质量不足进入 `needs_quality_revision`，不让 SEO/GEO 覆盖。
3. 选题来源必须直接支撑主题事实；非亚马逊电商来源要压低或拒绝。
4. `source_items.content_text` 已开始入库，topic prompt 优先使用正文片段。
5. Viewer 读表契约不变，改数据形状要标注。
6. 可观测性 review（见 `docs/18_observability_review.md`）中 workflow 侧基础修复已落地：生成 model_run 回填文章、run 异常收尾、长 AI 心跳、round 字段、`db list` 序列化、run-id 本地日期、中文业务节点展示。仍需单独设计的是：`needs_fact_sources` 后是否自动插入来源补全与修订，避免补位循环继续生成新文。

## Viewer 契约

- `engine_runs.summary_json`：`targetReady`、`readyCount`、`attemptedWritingTasks`、`qualityFailedCount`、`businessOutcome`
- `engine_reports.report_json`：`qualityOverview`、`portfolioHealth`、`taxonomySummary`、`sourceObservationCoverage`、`sourceLanes`、`observability`
- `workflow_steps.step_key`：保持下划线命名
- `topic_candidates`：`selection_*`、`deferred_until`、`portfolio_debug_json`
- `articles`：`article_quality_score`、`visual_plan_json`、分类三字段
