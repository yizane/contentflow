# 01 — Requirements

## 项目定位

本项目是 **Flyfus 内容生成引擎**（Content Generation Engine），不是 Web 应用。

- 产出面向中国亚马逊卖家的中文 SEO/GEO 文章（兼顾 Google/百度收录与 ChatGPT/Perplexity/AI Overview 引用）
- 自动链路：采集 → 主题池 → 文章生成 → 质量门 → 事实核查 → 来源修订 → 渠道改写 → 双评分 → 发布包
- **Web 是独立项目，两者只通过 MySQL 通讯**；本项目不做 Web UI（本地 Viewer 仅为开发控制台）
- **真实发布不在本项目内**——产出止于 publish_packages + 人工终审标记

## 内容铁律

1. 事实优先：无来源数字不得写成事实；不确定信息降级表达
2. 官方事实只认官方源（Amazon/Google 域名）；中文行业源仅作选题线索
3. Flyfus 能力以 config/internal_claims.yaml 白名单为准，禁止承诺排名/推荐/ACoS
4. 正文零 AI 工作流痕迹
5. Amazon AI Shopping 命名口径（Rufus 已于 2026-05-13 整合为 Alexa for Shopping）

## 非目标

Strapi / Cron / Flyfus MCP 调用 / 真实发布 / Web UI / ORM / 本地文件作为运行时状态。
