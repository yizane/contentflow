# 04 — Prompts Map

prompt 文件是 Git 静态资产，由 `scripts/prompt_lib.js` 在内存组装成任务字符串（不落运行时文件）。

| 文件 | 用途 | 消费方（task_type） |
|---|---|---|
| openclaw_article_agent.md | 文章生成总则（角色/SOP/策略三模式/命名口径/禁词/离线处理） | article_generation |
| topic_generator.md | 候选主题生成 | topic_generation |
| fact_check.md | 事实核查（7 类 claim/风险/动作） | fact_check |
| source_resolution.md | 来源补全（官方源优先/internal claims/单 URL） | source_resolution |
| article_revision.md | 局部修订（不重写/slug 不变/CTA 保留） | article_revision |
| channel_repurpose.md | 渠道改写（wechat/douyin/xiaohongshu 规则） | channel_repurpose |
| seo_evaluator.md / geo_evaluator.md | 双评分 9+8 维度 | seo_geo_score |
| quality_gate.md / article_writer.md / topic_score.md / serp_gap.md | 规则被 openclaw_article_agent 吸收引用；独立文件保留为规范文档 | — |

配套约束：`config/internal_claims.yaml`（Flyfus 能力白名单，internal_claims_lib 注入所有相关任务）、`config/production_policy.yaml`（去重/节流）、`schemas/*.json`（输出契约，validate_data_lib 按此校验）。
