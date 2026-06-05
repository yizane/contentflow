# 08 — Quality & Review

## 四层质量体系

1. **结构校验**（validate_data_lib，代码级）：schema required、正文长度、FAQ/表格/TL;DR、AI 痕迹禁词、承诺类禁词（含否定语境豁免）、slug 唯一
2. **质量门**（Agent 自检，100 分 7 维度）：publish ≥80 / revise 70-79 / reject <70；AI 痕迹或口径过期强制 revise
3. **事实核查**（独立 Agent）：claim 逐条定级（keep/soften/remove/cite_required）→ needs_fact_sources / ready_after_minor_edits / not_ready；fix:sources 闭环（来源补全→修订→重核查）
4. **SEO/GEO 双评分**（9+8 维度 + fact/bizFit/readability）：strategy 加权；**factScore<60 不得 publish/ready**——评分不能绕过事实

## 人工终审

`review:mark`：reviewed/approved_for_publish 只能从 ready_for_review/reviewed 进入；rejected 必须 --note；审计入 review_actions + status_transitions。**发布动作在本项目外。**

## 内部数据边界

model_runs.task_prompt / raw_response、source_resolutions.notes、error stack——内部数据，Web 不默认展示。
