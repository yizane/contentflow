// prompt_lib.js — 任务 prompt 字符串组装（内存中，不落运行时文件）
// 所有 OpenClaw 任务都要求把结果 JSON 直接输出到对话回复中，由脚本解析入库。
const { internalClaimsBlock } = require('./internal_claims_lib');
const config = require('./config_lib');

// 配置来自 MySQL（config_lib 缓存）；仓库文件仅作 seed/fallback
function readPrompt(name) {
  return config.getDoc(`prompt:${name}`);
}
function readSchema(name) {
  return config.getDoc(`schema:${name}`).trim();
}
function extractSection(md, heading) {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start + 1, end).join('\n').trim();
}

const OUTPUT_RULE = `## 输出方式（必须遵守）

把完整结果 JSON 直接输出到你的回复中（这是唯一交付方式）：
- 只输出一个 JSON object，第一字符是 {，最后字符是 }
- 不要 Markdown code fence，不要解释文字，不要写任何文件
- 不要保存到 ~/.openclaw/workspace 或其他路径`;

// 候选主题生成
function topicGenerationPrompt({ sourceItems, keywordsCsv }) {
  const prompt = readPrompt('topic_generator.md');
  const schema = readSchema('topic_candidates.schema.json');
  const taxonomy = require('./taxonomy_lib').taxonomyPromptBlock();
  const list = sourceItems
    .map((i, n) => `${n + 1}. [${i.source_group}/${i.source_name}] ${i.title}\n   url: ${i.source_url}${i.summary ? `\n   summary: ${String(i.summary).slice(0, 150)}` : ''}${i.content_type ? `\n   分类: ${i.content_type} / ${i.business_category || '-'}` : ''}`)
    .join('\n');
  return `# 任务：生成 Flyfus 候选主题池\n\n${prompt.trim()}\n\n---\n\n## 输入 1：最新采集 source items（${sourceItems.length} 条）\n\n${list}\n\n---\n\n## 输入 2：关键词库（primaryKeyword 必须从这里选）\n\n\`\`\`csv\n${keywordsCsv}\n\`\`\`\n\n---\n\n## 输入 3：内容分类枚举（每个候选必须输出 contentType / businessCategory / topicCluster，从以下枚举选；source 的分类可继承也可根据选题角度修正）\n\n${taxonomy}\n\n---\n\n## 输出 Schema\n\n\`\`\`json\n${schema}\n\`\`\`\n\n---\n\n${OUTPUT_RULE}`;
}

// 文章生成（job）
function articleJobPrompt({ job, attempt = 1, previousFailures = [] }) {
  const agentPrompt = readPrompt('openclaw_article_agent.md');
  const s = (h) => extractSection(agentPrompt, h);
  const strategy = job.strategy || 'balanced';
  const retryBlock = attempt > 1
    ? `\n## ⚠️ 重试说明（第 ${attempt} 次尝试）\n\n上一次输出未通过校验：\n${previousFailures.map((f) => `- ${f}`).join('\n')}\n\n请修复后再输出。\n`
    : '';
  return `# 任务：生成 Flyfus 文章（job: ${job.id}，strategy: ${strategy}）
${retryBlock}
## 选题

- topic: ${job.topic}
- primaryKeyword（不可更换）: ${job.primary_keyword}
- secondaryKeywords: ${(job.secondaryKeywords || []).join('、') || '（无）'}
- category: ${job.category}
- contentAngle: ${job.content_angle}
- businessAngle: ${job.business_angle}
- 参考来源 URL（可用 web_fetch 核实）:
${(job.sourceUrls || []).map((u) => `  - ${u}`).join('\n') || '  （无，需 web_search 自行核查关键事实）'}

## 角色与目标

你是 Flyfus 的 SEO/GEO 文章生产 Agent，面向中国亚马逊卖家写高质量中文文章（SEO + GEO + 转化，禁止硬广）。

## 生成策略（本次: ${strategy}）

${s('生成策略（strategy modes）')}

## source 使用规则

${s('source 使用规则（必须遵守）')}

## 写作 SOP

${s('写作 SOP')}

## Amazon AI Shopping 命名口径

${s('Amazon AI Shopping 命名口径（必须遵守）')}

## 联网/搜索不可用时的处理

${s('联网/搜索不可用时的处理（必须遵守）')}

## 正文禁词

${s('正文禁词（articleMarkdown 禁止出现）')}

## 文章 JSON Schema（article 字段必须符合）

\`\`\`json
${readSchema('article.schema.json')}
\`\`\`

## 质量门 JSON Schema（quality 字段必须符合，规则见下）

${s('质量门（自检）')}

\`\`\`json
${readSchema('quality.schema.json')}
\`\`\`

${OUTPUT_RULE}

最终输出结构：{"article": <符合 article schema 的对象>, "quality": <符合 quality schema 的对象>}`;
}

// 事实核查（针对一段 markdown + quality）
function factCheckPrompt({ articleMarkdown, quality, label }) {
  const fcPrompt = readPrompt('fact_check.md');
  const s = (h) => extractSection(fcPrompt, h);
  return `# 任务：文章事实核查（${label}）

## 任务说明

${s('任务')}

### 规则（必须遵守）

${s('规则（必须遵守）')}

### publishReadiness 判定

${s('publishReadiness 判定')}

${internalClaimsBlock()}

## 待核查文章全文

<article>

${articleMarkdown.trim()}

</article>

## 质量门结果（参考）

\`\`\`json
${JSON.stringify(quality, null, 2)}
\`\`\`

## 输出 Schema

\`\`\`json
${readSchema('fact_check.schema.json')}
\`\`\`

${OUTPUT_RULE}`;
}

// 渠道改写
function channelsPrompt({ articleMarkdown, articleJson, quality, factCheck, channels, label }) {
  const prompt = readPrompt('channel_repurpose.md');
  return `# 任务：多渠道改写（${label}）

本次只需生成以下渠道：**${channels.join(' / ')}**

---

${prompt.trim()}

---

## 文章状态上下文

- 质量门: score ${quality ? quality.score : '-'} / ${quality ? quality.publishRecommendation : '-'}
- 事实核查: ${factCheck ? `${factCheck.overallRisk} / ${factCheck.publishReadiness}，mustFix ${(factCheck.mustFixBeforePublish || []).length} 条` : '（未核查，按保守口吻处理）'}
${factCheck && (factCheck.mustFixBeforePublish || []).length ? '- 待补来源事项（保持保守口吻）：\n' + factCheck.mustFixBeforePublish.map((m) => `  - ${m}`).join('\n') : ''}

## 文章全文

<article>

${articleMarkdown.trim()}

</article>

## 文章元数据

- primaryKeyword: ${articleJson.primaryKeyword}
- flyfusCta: ${articleJson.flyfusCta}
- sources: ${(articleJson.sources || []).map((x) => `${x.sourceName}(${x.sourceTrust})`).join('、')}

## 单渠道输出 Schema

\`\`\`json
${readSchema('channel_outputs.schema.json')}
\`\`\`

${OUTPUT_RULE}

最终输出结构：{${channels.map((c) => `"${c}": <符合 schema 的对象>`).join(', ')}}`;
}

// 来源补全
function sourceResolutionPrompt({ article, articleJson, articleMarkdown, claims, mustFix }) {
  const prompt = readPrompt('source_resolution.md');
  return `# 任务：事实来源补全（article: ${article.id}）

${prompt.trim()}

---

${internalClaimsBlock()}

---

## 文章元数据

- articleId: ${article.id}（输出 JSON 的 articleId 必须用这个值）
- 标题: ${articleJson.articleTitle}
- 现有 sources:
${(articleJson.sources || []).map((x) => `  - [${x.sourceTrust}] ${x.sourceName}: ${x.sourceUrl}`).join('\n')}

## 待处理 mustFixBeforePublish（${mustFix.length} 条）

${mustFix.map((m, i) => `${i + 1}. ${m}`).join('\n')}

## 待补来源 claims（${claims.length} 条）

\`\`\`json
${JSON.stringify(claims, null, 2)}
\`\`\`

## 文章正文（供理解上下文，不需修改文章）

<article>

${articleMarkdown.trim()}

</article>

## 输出 Schema

\`\`\`json
${readSchema('source_resolution.schema.json')}
\`\`\`

${OUTPUT_RULE}`;
}

// 文章修订
function revisionPrompt({ article, articleJson, resolution, mustFix }) {
  const prompt = readPrompt('article_revision.md');
  return `# 任务：文章修订（article: ${article.id}）

${prompt.trim()}

---

${internalClaimsBlock()}

---

## 输入 1：原文章 JSON（articleMarkdown 即原全文）

\`\`\`json
${JSON.stringify(articleJson, null, 2)}
\`\`\`

## 输入 2：source_resolution（修订依据）

\`\`\`json
${JSON.stringify(resolution, null, 2)}
\`\`\`

## 输入 3：原 fact_check mustFixBeforePublish

\`\`\`json
${JSON.stringify(mustFix, null, 2)}
\`\`\`

## 输出 Schema（修订后完整文章 JSON）

\`\`\`json
${readSchema('revised_article.schema.json')}
\`\`\`

${OUTPUT_RULE}`;
}

// SEO/GEO 双评分
function scorePrompt({ article, articleMarkdown, articleJson, factCheck, sourceResolution, strategy, weights }) {
  const seoPrompt = readPrompt('seo_evaluator.md');
  const geoPrompt = readPrompt('geo_evaluator.md');
  const w = weights;
  return `# 任务：SEO/GEO 双评分（article: ${article.id}，strategy: ${strategy}）

## 第一步：SEO 评分

${seoPrompt.trim()}

## 第二步：GEO 评分

${geoPrompt.trim()}

## 第三步：双评分汇总（dual_quality）

补充三个独立维度（各 0-100）：factScore（依据 fact_check/source_resolution）、businessFitScore、readabilityScore。

按 strategy=${strategy} 加权：overallScore = round(${w.seo}*seoScore + ${w.geo}*geoScore + ${w.fact}*factScore + ${w.businessFit}*businessFitScore + ${w.readability}*readabilityScore)

recommendation 规则（事实优先）：factScore < 60 → 最高 revise；overall >= 80 且 fact >= 70 → ready_for_review/publish；60-79 → revise；< 60 → reject。

dual 必须符合：

\`\`\`json
${readSchema('dual_quality.schema.json')}
\`\`\`

## 评分对象：文章全文

<article>

${articleMarkdown.trim()}

</article>

## 文章 JSON

\`\`\`json
${JSON.stringify(articleJson, null, 2)}
\`\`\`

## 事实核查结果

\`\`\`json
${factCheck ? JSON.stringify(factCheck, null, 2) : '（无 fact_check——factScore 保守评估并在 mustFix 注明）'}
\`\`\`

${sourceResolution ? `## 来源补全记录\n\n\`\`\`json\n${JSON.stringify(sourceResolution, null, 2)}\n\`\`\`` : ''}

${OUTPUT_RULE}

最终输出结构：{"seo": <seo_score 对象>, "geo": <geo_score 对象>, "dual": <dual_quality 对象>}`;
}

// 搜索采集
function searchCollectPrompt({ queries, nowIso }) {
  const list = queries.map((q, i) => `${i + 1}. query: "${q.query}"（主题: ${q.name}，category: ${q.category}）`).join('\n');
  return `你是 Flyfus 内容引擎的搜索采集器。用 web_search 依次执行 ${queries.length} 个 query，每个取前 5 条：

${list}

要求：
1. 只输出一个 JSON 数组（不要 code fence、不要解释、不要写文件）。
2. 元素字段：{"title":"","url":"","snippet":"","sourceName":"","query":"","retrievedAt":"${nowIso}"}
3. 某 query 失败就跳过，不要编造。结果按 url 去重。`;
}

// 内容分类（批量：items 带 index；输出 JSON array）
function classificationPrompt({ items }) {
  const prompt = readPrompt('content_classifier.md');
  const schema = readSchema('content_classification.schema.json');
  const taxonomy = require('./taxonomy_lib').taxonomyPromptBlock();
  const list = items.map((it) => {
    const lines = [`${it.index}. title: ${it.title}`];
    if (it.summary) lines.push(`   summary: ${String(it.summary).slice(0, 280)}`);
    if (it.snippet) lines.push(`   snippet: ${String(it.snippet).slice(0, 280)}`);
    if (it.sourceGroup || it.sourceName) lines.push(`   source: ${it.sourceGroup || '-'} / ${it.sourceName || '-'}（仅参考，不是内容分类）`);
    if (it.keywords && it.keywords.length) lines.push(`   keywords: ${it.keywords.join('、')}`);
    if (it.ruleHint) lines.push(`   规则初判（供参考，可推翻）: ${it.ruleHint}`);
    return lines.join('\n');
  }).join('\n');
  return `# 任务：内容分类（${items.length} 条）

${prompt.trim()}

---

## 分类枚举（content_taxonomy）

${taxonomy}

---

## 待分类内容

${list}

---

## 输出 Schema（每个数组元素）

\`\`\`json
${schema}
\`\`\`

---

## 输出方式（必须遵守）

把完整结果 JSON array 直接输出到你的回复中：
- 只输出一个 JSON array，第一字符是 [，最后字符是 ]
- 每个元素带 index（对应输入编号）
- 不要 Markdown code fence，不要解释文字，不要写任何文件`;
}

module.exports = { topicGenerationPrompt, articleJobPrompt, factCheckPrompt, channelsPrompt, sourceResolutionPrompt, revisionPrompt, scorePrompt, searchCollectPrompt, classificationPrompt, OUTPUT_RULE };
