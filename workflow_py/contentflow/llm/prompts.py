from __future__ import annotations

import json
from typing import Any

from contentflow.core import config

OUTPUT_RULE = """## 输出方式（必须遵守）

把完整结果 JSON 直接输出到你的回复中（这是唯一交付方式）：
- 只输出一个 JSON object，第一字符是 {，最后字符是 }
- 不要 Markdown code fence，不要解释文字，不要写任何文件
- 不要保存到 ~/.openclaw/workspace 或其他路径"""


def read_prompt(name: str) -> str:
    return config.read_text_doc(name)


def read_schema(name: str) -> str:
    return (config.ROOT / "schemas" / f"{name}.schema.json").read_text(encoding="utf-8").strip()


def taxonomy_prompt_block() -> str:
    taxonomy = config.read_yaml("content_taxonomy")

    def fmt(mapping: dict[str, Any], extra=None) -> str:
        rows = []
        for key, value in mapping.items():
            suffix = extra(value) if extra else ""
            rows.append(f"- {key}：{value.get('label_zh')} — {value.get('description') or ''}{suffix}")
        return "\n".join(rows)

    clusters = "\n".join(
        f"- {key}：{value.get('label_zh')}（属于 {value.get('business_category')}）"
        for key, value in (taxonomy.get("topic_clusters") or {}).items()
    )
    return f"""### content_types（内容形态，必选其一）
{fmt(taxonomy.get("content_types") or {})}

### business_categories（业务主题，必选其一）
{fmt(taxonomy.get("business_categories") or {})}

### topic_clusters（主题簇，可选；必须与 business_category 一致，无合适项返回 ""）
{clusters}"""


def topic_generation_prompt(*, source_items: list[dict[str, Any]], keywords_csv: str, recent_topics: list[str] | None = None) -> str:
    recent_topics = recent_topics or []
    prompt = read_prompt("topic_generator")
    schema = read_schema("topic_candidates")

    def source_excerpt(item: dict[str, Any]) -> str:
        return str(item.get("content_text") or item.get("contentText") or item.get("summary") or "")[:360]

    source_rows = []
    for index, item in enumerate(source_items):
        excerpt = source_excerpt(item)
        source_rows.append(
            f"{index + 1}. [{item.get('source_group')}/{item.get('source_name')}] {item.get('title')}\n"
            f"   url: {item.get('source_url')}"
            f"{chr(10) + '   excerpt: ' + excerpt if excerpt else ''}"
            f"{chr(10) + '   分类: ' + str(item.get('content_type')) + ' / ' + str(item.get('business_category') or '-') if item.get('content_type') else ''}"
        )
    sources_block = "\n".join(source_rows)
    recent_block = "\n".join(f"{index + 1}. {topic}" for index, topic in enumerate(recent_topics)) if recent_topics else "（暂无）"
    return f"""# 任务：生成 Flyfus 候选主题池

{prompt.strip()}

---

## 输入 1：最新采集 source items（{len(source_items)} 条）

{sources_block}

---

## 输入 2：关键词库（primaryKeyword 必须从这里选）

```csv
{keywords_csv}
```

---

## 输入 2.5：近期已写主题（nonRepetition 评分依据；与这些重复/换壳的候选 nonRepetition ≤ 5）

{recent_block}

---

## 输入 3：内容分类枚举（每个候选必须输出 contentType / businessCategory / topicCluster，从以下枚举选；source 的分类可继承也可根据选题角度修正）

{taxonomy_prompt_block()}

---

## 输出 Schema

```json
{schema}
```

---

{OUTPUT_RULE}"""


def extract_section(markdown: str, heading: str) -> str:
    lines = markdown.splitlines()
    needle = f"## {heading}"
    try:
        start = next(index for index, line in enumerate(lines) if line.strip() == needle)
    except StopIteration:
        return ""
    end = len(lines)
    for index in range(start + 1, len(lines)):
        if lines[index].startswith("## "):
            end = index
            break
    return "\n".join(lines[start + 1:end]).strip()


def article_generation_prompt(*, writing_task: dict[str, Any], attempt: int = 1, previous_failures: list[str] | None = None) -> str:
    previous_failures = previous_failures or []
    agent_prompt = read_prompt("openclaw_article_agent")
    section = lambda heading: extract_section(agent_prompt, heading)
    strategy = writing_task.get("strategy") or "balanced"
    retry_block = ""
    if attempt > 1:
        retry_block = f"""
## ⚠️ 重试说明（第 {attempt} 次尝试）

上一次输出未通过校验：
{chr(10).join(f"- {failure}" for failure in previous_failures)}

请修复后再输出。
"""
    return f"""# 任务：生成 Flyfus 文章（writing task: {writing_task.get('id')}，strategy: {strategy}）
{retry_block}
## 选题

- topic: {writing_task.get('topic')}
- primaryKeyword（不可更换）: {writing_task.get('primary_keyword')}
- secondaryKeywords: {'、'.join(writing_task.get('secondaryKeywords') or []) or '（无）'}
- category: {writing_task.get('category')}
- contentAngle: {writing_task.get('content_angle')}
- businessAngle: {writing_task.get('business_angle')}
- 参考来源 URL（可用 web_fetch 核实）:
{chr(10).join(f"  - {url}" for url in (writing_task.get('sourceUrls') or [])) or '  （无，需 web_search 自行核查关键事实）'}

## 角色与目标

你是 Flyfus 的 SEO/GEO 文章生产 Agent，面向中国亚马逊卖家写高质量中文文章（SEO + GEO + 转化，禁止硬广）。

## 生成策略（本次: {strategy}）

{section('生成策略（strategy modes）')}

## source 使用规则

{section('source 使用规则（必须遵守）')}

## 写作 SOP

{section('写作 SOP')}

## Amazon AI Shopping 命名口径

{section('Amazon AI Shopping 命名口径（必须遵守）')}

## 联网/搜索不可用时的处理

{section('联网/搜索不可用时的处理（必须遵守）')}

## 正文禁词

{section('正文禁词（articleMarkdown 禁止出现）')}

## 文章 JSON Schema（article 字段必须符合）

```json
{read_schema('article')}
```

## 质量门 JSON Schema（quality 字段必须符合，规则见下）

{section('质量门（自检）')}

```json
{read_schema('quality')}
```

{OUTPUT_RULE}

最终输出结构：{{"article": <符合 article schema 的对象>, "quality": <符合 quality schema 的对象>}}"""


def fact_check_prompt(*, article_markdown: str, quality: dict[str, Any], label: str) -> str:
    prompt = read_prompt("fact_check")
    section = lambda heading: extract_section(prompt, heading)
    return f"""# 任务：文章事实核查（{label}）

## 任务说明

{section('任务')}

### 规则（必须遵守）

{section('规则（必须遵守）')}

### publishReadiness 判定

{section('publishReadiness 判定')}

## 待核查文章全文

<article>

{article_markdown.strip()}

</article>

## 质量门结果（参考）

```json
{quality}
```

## 输出 Schema

```json
{read_schema('fact_check')}
```

{OUTPUT_RULE}"""


def score_prompt(*, article: dict[str, Any], article_markdown: str, article_json: dict[str, Any], fact_check: dict[str, Any] | None, source_resolution: dict[str, Any] | None, strategy: str, weights: dict[str, float]) -> str:
    return f"""# 任务：SEO/GEO 双评分

请按策略 `{strategy}` 对文章进行 SEO 与 GEO 双评分。

## 权重

```json
{weights}
```

## 文章

<article>

{article_markdown.strip()}

</article>

## 文章 JSON

```json
{article_json}
```

## 事实核查

```json
{fact_check or {}}
```

## 来源补全

```json
{source_resolution or {}}
```

## 输出 Schema

返回一个 JSON object：
{{"seo": <seo_score>, "geo": <geo_score>, "dual": <dual_quality>}}

seo_score:
```json
{read_schema('seo_score')}
```

geo_score:
```json
{read_schema('geo_score')}
```

dual_quality:
```json
{read_schema('dual_quality')}
```

{OUTPUT_RULE}"""


def source_resolution_prompt(*, article: dict[str, Any], article_json: dict[str, Any], article_markdown: str, claims: list[dict[str, Any]], must_fix: list[str]) -> str:
    prompt = read_prompt("source_resolution")
    sources = article_json.get("sources") or []
    return f"""# 任务：事实来源补全（article: {article.get('id')}）

{prompt.strip()}

---

## 文章元数据

- articleId: {article.get('id')}（输出 JSON 的 articleId 必须用这个值）
- 标题: {article_json.get('articleTitle') or article.get('title')}
- 现有 sources:
{chr(10).join(f"  - [{source.get('sourceTrust')}] {source.get('sourceName')}: {source.get('sourceUrl')}" for source in sources) or "  （无）"}

## 待处理 mustFixBeforePublish（{len(must_fix)} 条）

{chr(10).join(f"{index + 1}. {item}" for index, item in enumerate(must_fix)) or "（无）"}

## 待补来源 claims（{len(claims)} 条）

```json
{json.dumps(claims, ensure_ascii=False, indent=2)}
```

## 文章正文（供理解上下文，不需修改文章）

<article>

{article_markdown.strip()}

</article>

## 输出 Schema

```json
{read_schema('source_resolution')}
```

{OUTPUT_RULE}"""


def revision_prompt(*, article: dict[str, Any], article_json: dict[str, Any], resolution: dict[str, Any], must_fix: list[str]) -> str:
    prompt = read_prompt("article_revision")
    return f"""# 任务：文章修订（article: {article.get('id')}）

{prompt.strip()}

---

## 输入 1：原文章 JSON（articleMarkdown 即原全文）

```json
{json.dumps(article_json, ensure_ascii=False, indent=2)}
```

## 输入 2：source_resolution（修订依据）

```json
{json.dumps(resolution, ensure_ascii=False, indent=2)}
```

## 输入 3：原 fact_check mustFixBeforePublish

```json
{json.dumps(must_fix, ensure_ascii=False, indent=2)}
```

## 输出 Schema（修订后完整文章 JSON）

```json
{read_schema('revised_article')}
```

{OUTPUT_RULE}"""


def classification_prompt(*, items: list[dict[str, Any]]) -> str:
    prompt = read_prompt("content_classifier")
    rows: list[str] = []
    for item in items:
        lines = [f"{item.get('index')}. title: {item.get('title') or ''}"]
        if item.get("summary"):
            lines.append(f"   summary: {str(item.get('summary'))[:280]}")
        if item.get("snippet"):
            lines.append(f"   snippet: {str(item.get('snippet'))[:280]}")
        if item.get("sourceGroup") or item.get("sourceName"):
            lines.append(f"   source: {item.get('sourceGroup') or '-'} / {item.get('sourceName') or '-'}（仅参考，不是内容分类）")
        if item.get("keywords"):
            lines.append(f"   keywords: {'、'.join(item.get('keywords') or [])}")
        if item.get("ruleHint"):
            lines.append(f"   规则初判（供参考，可推翻）: {item.get('ruleHint')}")
        rows.append("\n".join(lines))
    return f"""# 任务：内容分类（{len(items)} 条）

{prompt.strip()}

---

## 分类枚举（content_taxonomy）

{taxonomy_prompt_block()}

---

## 待分类内容

{chr(10).join(rows)}

---

## 输出 Schema（每个数组元素）

```json
{read_schema('content_classification')}
```

---

## 输出方式（必须遵守）

把完整结果 JSON array 直接输出到你的回复中：
- 只输出一个 JSON array，第一字符是 [，最后字符是 ]
- 每个元素带 index（对应输入编号）
- 不要 Markdown code fence，不要解释文字，不要写任何文件"""


def article_quality_prompt(*, article: dict[str, Any], article_markdown: str, content_type: str | None, recent_titles: list[str] | None = None, visual_plan: list[dict[str, Any]] | None = None) -> str:
    recent_titles = recent_titles or []
    prompt = read_prompt("article_quality_evaluator")
    return f"""# 任务：文章质量主评分（article: {article.get('id')})

{prompt.strip()}

---

## 文章信息

- 标题: {article.get('title')}
- 内容类型: {content_type or article.get('content_type') or '（未分类）'}
- 业务分类: {article.get('business_category') or '-'}
- visualPlan: {str(len(visual_plan)) + ' 个视觉规划' if visual_plan else '（缺失：clarity/actionability 酌情扣分）'}

## 近期已发文章标题（重复判断依据）

{chr(10).join(f"{index + 1}. {title}" for index, title in enumerate(recent_titles)) or "（暂无）"}

## 文章全文

<article>

{article_markdown.strip()}

</article>

---

## 输出 Schema

```json
{read_schema('article_quality_score')}
```

---

{OUTPUT_RULE}"""


def channels_prompt(*, article_markdown: str, article_json: dict[str, Any], quality: dict[str, Any] | None, fact_check: dict[str, Any] | None, channels: list[str], label: str) -> str:
    prompt = read_prompt("channel_repurpose")
    return f"""# 任务：多渠道改写（{label}）

本次只需生成以下渠道：**{' / '.join(channels)}**

---

{prompt.strip()}

---

## 文章状态上下文

- 质量门: {quality or {}}
- 事实核查: {fact_check or {}}

## 文章全文

<article>

{article_markdown.strip()}

</article>

## 文章元数据

```json
{article_json}
```

## 输出 Schema

每个渠道值必须符合：
```json
{read_schema('channel_outputs')}
```

最终输出一个 JSON object，key 为渠道名，例如：
{{"wechat": <channel_output>, "douyin": <channel_output>}}

{OUTPUT_RULE}"""
