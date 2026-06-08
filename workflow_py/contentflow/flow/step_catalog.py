from __future__ import annotations


STEP_DEFINITIONS: dict[str, dict[str, str]] = {
    "sources:collect": {"key": "sources_collect", "name": "资料采集"},
    "topics:generate": {"key": "topics_generate", "name": "候选主题生成"},
    "topics:select": {"key": "topics_select", "name": "选题入选与写作排队"},
    "articles:generate": {"key": "articles_generate", "name": "文章初稿生成"},
    "articles:factcheck": {"key": "articles_factcheck", "name": "事实核查与来源门禁"},
    "score:article-quality": {"key": "article_quality_score", "name": "文章质量主评分"},
    "score:seo-geo": {"key": "seo_geo_score", "name": "SEO/GEO 辅助评分"},
    "channels:generate": {"key": "channels_generate", "name": "渠道改写"},
    "sources:resolve": {"key": "sources_resolve", "name": "来源解析"},
    "sources:fix": {"key": "sources_fix", "name": "来源补全与修订"},
    "articles:revise": {"key": "articles_revise", "name": "文章修订"},
    "content:classify": {"key": "content_classify", "name": "内容分类回填"},
    "package:export": {"key": "package_export", "name": "发布包生成"},
    "review:mark": {"key": "review_mark", "name": "人工终审"},
    "topic:audition": {"key": "topics_audition", "name": "选题压力测试"},
    "engine:report": {"key": "engine_report", "name": "运行报告"},
    "db:list": {"key": "db_list", "name": "运行摘要"},
    "db:show": {"key": "db_show", "name": "文章详情读取"},
}


def step_key_from_name(name: str) -> str:
    definition = STEP_DEFINITIONS.get(str(name or ""))
    if definition:
        return definition["key"]
    return str(name or "").replace(":", "_")


def step_display_name(name: str) -> str:
    definition = STEP_DEFINITIONS.get(str(name or ""))
    if definition:
        return definition["name"]
    return str(name or "")
