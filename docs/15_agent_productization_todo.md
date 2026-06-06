# 15 — Agent Productization TODO

记录时间：2026-06-05

基于“垂直行业 Agent 产品开发指导思想”和当前代码架构的对照，当前方向基本正确：业务系统掌控 workflow、状态、审计和质量闭环，OpenClaw 只是执行层。但从 MVP 走向产品化，还需要补齐以下事项。

## P0：评估集与回归

- 建立节点级 eval cases：主题生成、文章生成、事实核查、来源补全、渠道改写、SEO/GEO 评分。
- 增加 eval runner：固定输入、期望输出特征、schema 校验、业务规则校验、得分报告。
- 记录 prompt / config / model 版本与 eval 结果，支持改 prompt/SOP 前后对比。
- 把“生产时质量门”和“开发时回归评估”分开，避免只靠体感调 prompt。

## P0：节点分型

- 为每个 pipeline step 标注执行类型：`rule` / `llm` / `agent` / `human`。
- 默认从最低配开始：能用规则不用模型，能用裸 LLM 不用 agent。
- 只把需要观察、搜索、浏览器操作、失败后自主修正的节点升级为 agent。
- Agent 节点只接收结构化输入、只保存最终结构化产物，中间过程留在内部 trace/model_runs。

## P1：OpenClaw Worker 化

- 保持业务系统作为控制面和状态源，OpenClaw 继续作为 worker/执行器。
- 评估从 CLI 子进程调用迁移到 OpenAI-compatible HTTP API 的成本与收益。
- 增加 provider/model/cost/concurrency 观测，支撑单位经济模型。
- 锁定 OpenClaw 版本并建立定期升级验证流程，避免裸跟 latest。
- 保持 prompt、schema、工具脚本、eval cases 框架无关，控制退出成本。

## P1：Workflow 与队列

- 当前 `engine_batch.js` 串行子进程编排适合 MVP；产品化阶段需要引入 queue/worker。
- 明确任务生命周期：pending/running/succeeded/partial/failed/cancelled/superseded。
- 支持任务取消、失败重试、崩溃恢复、并发水位控制和跨客户隔离。
- 只有跨天长流程、人工等待和崩溃恢复成为硬需求时，再评估 Temporal。

## P1：SaaS 控制面

- 补齐 tenant/customer 边界、权限、客户资产库、客户风格、案例库。
- 增加配额、计费、成本归因、客户级并发限制。
- 记录客户修改意见，并归因到 prompt、SOP、资料缺失、事实来源、风格偏差等类别。
- 增加 prompt/skill/config 版本管理、回滚和发布审批。

## P2：人工审批与交付闭环

- 细化人工终审节点：待审、退回修改、批准发布、已发布、归档。
- 明确高风险和不可逆操作必须人工确认。
- 将发布包、渠道稿、事实核查、来源补全、SEO/GEO 评分汇总成客户可验收视图。
- 沉淀优秀输出作为 eval case 和 few-shot 示例来源。

## 原则备忘

- Workflow 主控，Agent 辅助。
- OpenClaw 做执行层，不做控制面。
- Eval 和判断标准优先于继续打磨 prompt 措辞。
- 节点只升不降，升级为 agent 要有评估数据支撑。
- 产品护城河来自行业 SOP、质量标准、客户反馈和交付流程，而不是 runtime 自研。
