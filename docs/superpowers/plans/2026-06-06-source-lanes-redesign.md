# Source Lanes Redesign — 数据源三分类与消费策略（执行版）

> 状态：执行版。已采纳第七节的四个建议决策。本方案与
> `2026-06-06-source-story-topic-dedupe.md` 配套：
> dedupe plan 解决"重复怎么识别"，本方案解决"源怎么分类、素材怎么消费"。
> 建议两个方案合并实施（共用同一个 migration 011），并采纳 dedupe plan 评审中的瘦身结论
> （v1 砍 story_clusters 与模型 sourceAssessments —— 新闻源收敛到 2-3 个后，跨源同新闻合并的需求大幅下降）。
> 关键约束：v1 不给 `source_items` 加列；lane 与素材使用状态写入 dedupe plan 的
> `source_canonical_items` 新表，避免影响 Viewer 既有查询。

**Owner:** Codex（workflow 侧，不涉及 Viewer 文件）

---

## 一、问题

1. 源太多太乱：`sources.yaml` 共 ~35 个源，新闻/博客/官方公告/社区/搜索混在一起，无差别全量采集。
2. 重复采集严重：AMZ123 三个页面（头条/早报/快讯）内容高度重叠；雨果跨境两个条目重复；
   About Amazon 两个静态参考页每天抓出同样的 page-level item。
3. 元数据有了但没人消费：每个源已有 `freshness`（breaking_news/policy_update/evergreen_blog）、
   `source_policy.max_age_hours` 已定义 72h/168h/720h 三档，但 `collectSources` 与 `generateTopics`
   完全没有使用这些字段。
4. 老素材永远没机会：`generateTopics` 取源用 `ORDER BY created_at DESC LIMIT 60`，
   evergreen 素材只在入库当天有机会进选题 prompt，之后被新数据顶掉，"累积素材库"名存实亡。

## 二、核心模型：三条 Lane

按"消费方式"把源分为三类（不是按主题分）：

| Lane | 消费窗口 | 源数量目标 | 用途 | 对应现有 freshness |
|---|---|---|---|---|
| `news` | first_seen 72h 内 | **2-3 个 active**（中文 1 + 英文 1-2） | 时效热点、每日选题雷达 | breaking_news |
| `policy` | first_seen 7 天内 | 4-5 个（全部官方/半官方） | 政策更新，唯一可作主事实来源 | policy_update |
| `knowledge` | 无窗口，累积，`used` 后退役 + 90 天软过期降权 | 可以多（10-15 个） | 方法论素材库，按轮转消费 | evergreen_blog |

设计决策（含理由）：

- **为什么三类不是两类**：官方政策源两边都放不进——更新频率低不能"只看当天"，
  有时效性又不能当素材累积，且是唯一 `can_be_primary_fact_source` 的源，必须独立成 lane。
- **新闻"当天"用 `first_seen_at` 代理，不用 `published_at`**：fetch_page 类源解析不出发布时间
  （AMZ123、Seller Central 的 publishedAt 全空）。canonical 去重保证每条只有一次 first_seen，
  "第一次被看到"即新闻日。窗口取 72h 而非自然日：兼容某天 engine 没跑的情况，且与现有
  `max_age_hours.breaking_news: 72` 一致。
- **`used` 定义 = 支撑的选题已成文**（article generated 时标记），不是"进过候选池"。
  一个素材可支撑多角度候选；候选被 defer/淘汰不烧素材。同角度重复由选题去重拦截。
- **90 天软过期是降权不是禁用**：旧素材进 prompt 时附带 `retrieved_at`，由模型判断时效，
  fact-check 阶段兜底。

## 三、源清单整改（sources.yaml）

### news lane（收敛到 2-3 个 active + 备胎）

| 动作 | 源 | 理由 |
|---|---|---|
| 保留 | AMZ123 - 跨境快讯（/kx） | 中文新闻主源，更新最快 |
| **停用** | AMZ123 - 跨境头条（/t/）、跨境早报（/zb） | 与快讯高度重叠，是当前重复采集的最大来源；`enabled=0` 留作备胎 |
| 保留 | Marketplace Pulse Articles | 英文行业新闻最高质量，有验证过的 atom feed |
| 保留 | Search Engine Roundtable | SEO 快讯，社区信号更快 |
| **停用** | Retail Dive、Modern Retail、Digital Commerce 360、EcommerceBytes | 泛零售信噪比低；`enabled=0` |
| **停用** | 雨果跨境 RSS 探测条目 | 与首页条目重复，合并为一条 |
| 降级 | 雨果跨境、亿恩网、卖家之家、跨境知道、白鲸跨境 | 中文新闻只留 1 个主源；其余 `enabled=0` 备胎（AMZ123 失效时切换） |

### policy lane（保留，独立窗口）

- Amazon Seller Central News、Amazon Seller Forums Announcements、Amazon Ads Blog、
  Google Search Central Blog、About Amazon News（rss）。
- **移出每日采集**：About Amazon 的两个静态页（Alexa for Shopping / Rufus announcement）——
  它们是固定参考文档不是信息流，每天抓只产生同一条 page-level item。
  建议转为 `internal_claims.yaml` 的事实参考或单独的 reference 列表，不进 source_items。

### knowledge lane（可以多，累积消费）

- 全部 seller_tool_blogs（Jungle Scout、Helium 10、SellerApp、Teikametrics、Ad Badger、Intentwise）
- AMZ123 跨境报告、Amazon Ads Resources Library
- Google AI Blog、Perplexity Blog（403 待解，保留低优先级）
- Search Engine Journal（从新闻降级为 knowledge：教程类内容多于快讯）

### 其他

- community_signals（Reddit ×2）：v1 停用。痛点发现暂靠 AMZ123、论坛公告和 Marketplace Pulse，
  避免社区噪音进入日常候选。
- search_queries：每日只保留 3 条高优 query（Rufus / AI Overview / 政策），其余停用。

## 四、数据模型改动（并入 migration 011）

`sources.yaml` 每个源新增配置字段：

```yaml
lane: news | policy | knowledge
enabled: true | false
daily_query_enabled: true | false  # 仅 search_queries 使用
```

默认 lane 按现有 `freshness` 推导：

- `breaking_news` -> `news`
- `policy_update` -> `policy`
- `evergreen_blog` -> `knowledge`

DB 状态不写入 `source_items`，统一并入 dedupe plan 的 `source_canonical_items` 新表：

```sql
lane VARCHAR(16) NOT NULL DEFAULT 'knowledge',
usage_status VARCHAR(16) NOT NULL DEFAULT 'unused', -- unused | used | expired_soft
used_at DATETIME(3),
used_by_article_id VARCHAR(64),
times_in_prompt INT NOT NULL DEFAULT 0,
reactivated_at DATETIME(3),
content_fingerprint CHAR(64)
```

说明：

- `first_seen_at`、`last_seen_at`、canonical URL hash 来自 dedupe plan 的 `source_canonical_items`。
- 如果同一 canonical URL 被不同 lane 的源观察到，canonical lane 按 `policy > news > knowledge`
  提升，不做降级；这样官方政策源不会被新闻/博客源稀释。
- 两个方案必须同 migration 011 落地；011 只建新表，不 `ALTER source_items`。

## 五、流程改动

### 1. collectSources（scripts/lib/pipeline_lib.js）

- 只采集 `enabled=1` 的源（现状不变），ingest 时从源配置带入 `lane`。
- news lane：canonical 命中历史（非 72h 内 first_seen）→ 只记 observation，不重复入库（dedupe plan 行为）。
- policy lane：同 URL 内容指纹变化 → `observation_status='reactivated_source'`，
  更新 canonical 行的 `reactivated_at/content_fingerprint`，并更新 canonical 对应 `source_items`
  行的可变内容字段（title/summary/retrieved_at），但不新增第二条 `source_items`。

### 2. generateTopics 源范围构建（核心改动）

替换现有 `ORDER BY created_at DESC LIMIT 60` 为**三段配额拼装**：

```sql
-- news：同 run 有观察，且 canonical first_seen 仍在 72h 内
SELECT ... FROM source_observations so
JOIN source_canonical_items sci ON sci.canonical_url_hash = so.canonical_url_hash
JOIN source_items si ON si.id = sci.source_item_id
WHERE so.engine_run_id = ? AND sci.lane = 'news' AND sci.first_seen_at >= ?
GROUP BY si.id
ORDER BY MAX(so.created_at) DESC
LIMIT 25;

-- policy：7 天内 first_seen 或 reactivated 的官方/半官方源
SELECT ... FROM source_observations so
JOIN source_canonical_items sci ON sci.canonical_url_hash = so.canonical_url_hash
JOIN source_items si ON si.id = sci.source_item_id
WHERE so.engine_run_id = ? AND sci.lane = 'policy'
  AND (sci.first_seen_at >= ? OR sci.reactivated_at >= ?)
GROUP BY si.id
ORDER BY GREATEST(sci.first_seen_at, COALESCE(sci.reactivated_at, sci.first_seen_at)) DESC
LIMIT 15;

-- knowledge：不要求当天观察，消费 canonical 素材库里的 unused 内容
SELECT ... FROM source_canonical_items sci
JOIN source_items si ON si.id = sci.source_item_id
WHERE sci.lane = 'knowledge' AND sci.usage_status = 'unused'
ORDER BY sci.times_in_prompt ASC, sci.first_seen_at DESC
LIMIT 120;
```

- 配比 25/15/40 写入 `production_policy.yaml`（新增 `source_scope` 段），不硬编码。
- knowledge 先从 DB 取较大的未用候选池，再在 JS 中按源配置 priority、新鲜度衰减、
  `times_in_prompt` 惩罚取最终 40 条；不要假设 DB 里已有 `priority_score` 列。
- knowledge 排序的 `times_in_prompt` 惩罚保证轮转：进过 prompt 但没被选的素材逐渐让位，
  避免同一批素材每天霸占名额（这是"累积素材库"能转起来的关键）。
- 入选 prompt 的 knowledge item `times_in_prompt += 1`；news/policy 不累计该字段。
- prompt 中按 lane 分组展示，并给模型规则：
  - news 组 → 优先产 `news_flash`/`policy_update`/`trend_analysis` 类候选（时效内容）
  - knowledge 组 → 产 evergreen（operation_guide/case_study 等）
  - 素材 `retrieved_at` 超过 90 天 → prompt 内标注"旧素材，需确认时效"

### 3. used 标记（runArticleJob 成文时）

文章生成成功后，将 `topic_candidates.source_item_ids_json` 中 canonical lane 为 `knowledge` 的素材标记
`usage_status='used', used_at=now, used_by_article_id=articleId`。
news/policy 素材不标 used（时效窗口自然淘汰，无需占用状态）。

### 4. engine_report 新增观测

```
sourceLanes: {
  news:      { collected, fresh72h, inPrompt },
  policy:    { collected, fresh7d, inPrompt, reactivated },
  knowledge: { total, unused, used, softExpired, inPromptToday, oldestUnusedDays }
}
```

`oldestUnusedDays` 用于监控素材积压；`unused` 持续上涨说明 knowledge 源供给 > 消费，可减源。

## 六、验收标准

- 每日采集量下降 ≥50%（停用重叠源后），选题候选数量与质量不降（15-30/天）。
- 同一天的选题 prompt 中，news 素材全部 first_seen ≤72h，knowledge 素材全部 unused。
- 连续运行 7 天后：knowledge 素材有轮转（同一未用素材连续进 prompt ≤3 次）；
  已成文素材不再出现在 prompt 中。
- AMZ123 快讯连续 2 天采集失败时 engine_report 有 warning（备胎切换提示）。
- `npm test` 通过；Viewer API 形状不变（v1 不改 Viewer-owned 文件，且不向 `source_items`
  增加 schema 负担）。

## 七、已采纳决策

1. **Reddit 社区源**：v1 停用。
2. **search_queries**：每日 3 条高优（Rufus / AI Overview / 政策），其余停用。
3. **SEO 新闻**：news lane 保留 Search Engine Roundtable。
4. **knowledge used 语义**：v1 成文即退役；保留 `times_in_prompt` 字段，后续可改为降权复用。

## 八、非目标

- 不实现 news lane 的文章生成通道（news_only 信号继续按 dedupe plan 保留给未来 news lane）。
- 不实现 ETag/If-Modified-Since 条件请求（独立小优化，可后补）。
- 不动 Viewer 文件（`scripts/view_server.js`、`scripts/lib/ui_api_lib.js`、`webpage/`）。
