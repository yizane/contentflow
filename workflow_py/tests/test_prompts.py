from __future__ import annotations

from contentflow.core import config
from contentflow.llm import prompts


def test_keywords_csv_uses_csv_shape():
    csv_text = config.get_keywords_csv()

    assert csv_text.splitlines()[0] == "keyword,cluster,intent,priority,stage,business_angle"
    assert "," in csv_text


def test_topic_generation_prompt_contains_sources_taxonomy_and_schema():
    text = prompts.topic_generation_prompt(
        source_items=[{
            "source_group": "news",
            "source_name": "AMZ123 快讯",
            "title": "亚马逊关闭差评买家主动联系入口",
            "source_url": "https://www.amz123.com/kx/1",
            "summary": "卖家需要调整 Review SOP",
            "content_text": "完整正文里包含差评处理流程、买家沟通限制、Q&A 预防动作。",
        }],
        keywords_csv="keyword,cluster,intent,priority,stage,business_angle\n亚马逊广告,ppc,guide,1,growth,降本",
        recent_topics=["旧主题"],
    )

    assert "AMZ123 快讯" in text
    assert "https://www.amz123.com/kx/1" in text
    assert "完整正文里包含差评处理流程" in text
    assert "content_types" in text
    assert "topic_candidates.schema.json" in text
    assert "只输出一个 JSON object" in text
