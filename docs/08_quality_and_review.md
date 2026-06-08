# 08 — Quality & Review

## 四层质量体系

1. **结构校验**：`contentflow.validators` 校验 schema、正文长度、FAQ/表格/TL;DR、AI 痕迹禁词、承诺类禁词、slug 唯一等。
2. **文章质量主评分**：`article_quality_score` 满分 100，`>=80` 才能进入 `ready_for_review`。
3. **事实核查**：独立 factcheck 节点逐条判断 claim，必要时进入 `needs_fact_sources`，再由 `sources fix` 闭环。
4. **SEO/GEO 双评分**：辅助优化建议，不覆盖事实可靠性和文章质量主门禁。

## 人工终审

`review mark` 支持 `reviewed`、`approved_for_publish`、`rejected` 等状态。通过终审前必须满足：

- 文章状态允许转移；
- `article_quality_score >= 80`；
- 事实核查没有阻断项；
- `rejected` 必须带 note。

审计写 `review_actions` 和 `status_transitions`。发布动作在本项目外。

## 内部数据边界

`model_runs.task_prompt`、`model_runs.raw_response`、`source_resolutions.notes`、error stack 属内部调试数据，Web 不默认展示。
