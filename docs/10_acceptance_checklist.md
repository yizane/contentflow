# 10 — Acceptance Checklist（v1.0-rc1）

| # | 项 | 验证方式 | 状态 |
|---|---|---|---|
| 1 | MySQL 唯一数据源 | db:ping/init/migrate；零运行时本地文件（find 实测） | ✅ |
| 2 | engine:daily 全链路 | 真实跑通（采集 222 → 1 文章 → 核查 → 3 渠道） | ✅ |
| 3 | Daily 幂等 | start/retry 对 completed run 拒绝；rebuild 归档不删除 | ✅ |
| 4 | fix:sources 闭环 | needs_fact_sources → ready_for_review（多篇验证） | ✅ |
| 5 | 渠道三件套 | wechat/douyin/xiaohongshu 校验通过，不覆盖已有 | ✅ |
| 6 | 双评分 | breakdown 一致性 ±2、加权 ±3、事实优先约束 | ✅ |
| 7 | 发布包 | publish_packages 全内容入库，channelStatus/readyForPublishPackage | ✅ |
| 8 | trace 全覆盖 | steps/sources/events/transitions 四表 + Viewer 展示 | ✅ |
| 9 | Viewer 安全 | 8 端点泄露扫描（密码/RDS/prompt/raw_response）全绿 | ✅ |
| 10 | run_actions 审计 | CLI/Viewer 触发与拒绝全记录 | ✅ |
| 11 | legacy 清除 | sqlite/output/legacy 脚本已全部删除（数据已迁 MySQL）；主流程零文件依赖 | ✅ |
| 12 | 文档 12 份 | 01-12 全存在且口径一致 | ✅ |

详情见 docs/12_v1_acceptance_report.md。
