# 04 — Prompts Map

prompt 文件是 Git 静态资产，由 `workflow_py/contentflow/prompts.py` 在内存组装成任务字符串，不写运行时文件。

| 文件 | 用途 | task_type |
|---|---|---|
| openclaw_article_agent.md | 文章生成总则 | article_generation |
| topic_generator.md | 候选主题生成 | topic_generation |
| fact_check.md | 事实核查 | fact_check |
| source_resolution.md | 来源补全 | source_resolution |
| article_revision.md | 局部修订 | article_revision |
| channel_repurpose.md | 渠道改写 | channel_repurpose |
| seo_evaluator.md / geo_evaluator.md | SEO/GEO 双评分 | seo_geo_score |
| quality_gate.md | 文章质量主评分 | article_quality |

配套约束：

- `config/internal_claims.yaml`：Flyfus 能力白名单。
- `config/production_policy.yaml`：生产策略、去重、source scope。
- `config/content_taxonomy.yaml`：内容三层分类。
- `schemas/*.json`：输出契约，由 `contentflow.validators` 校验。
