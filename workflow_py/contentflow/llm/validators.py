from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from jsonschema import Draft202012Validator

from contentflow.core import config


@dataclass(slots=True)
class ValidationResult:
    ok: bool
    issues: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def load_schema(name: str) -> dict[str, Any]:
    return json.loads((config.ROOT / "schemas" / f"{name}.schema.json").read_text(encoding="utf-8"))


def validate_json_schema(data: Any, schema_name: str) -> ValidationResult:
    schema = load_schema(schema_name)
    validator = Draft202012Validator(schema)
    issues = [
        f"{'/'.join(str(part) for part in error.absolute_path) or '$'}: {error.message}"
        for error in sorted(validator.iter_errors(data), key=lambda err: list(err.absolute_path))
    ]
    return ValidationResult(ok=not issues, issues=issues)


def validate_topic_candidates_data(data: Any, keyword_set: set[str] | None = None) -> ValidationResult:
    schema_result = validate_json_schema(data, "topic_candidates")
    issues = list(schema_result.issues)
    warnings: list[str] = []
    candidates = data.get("candidates") if isinstance(data, dict) else None
    if isinstance(candidates, list):
        seen: set[str] = set()
        for index, candidate in enumerate(candidates):
            topic = str(candidate.get("topic") or "")
            norm = "".join(topic.split())
            if norm in seen:
                issues.append(f"candidates[{index}].topic 重复")
            seen.add(norm)
            if "Rufus 时代" in topic:
                issues.append(f'candidates[{index}] 过期口径 "Rufus 时代"')
            primary = candidate.get("primaryKeyword")
            if keyword_set and primary and primary not in keyword_set:
                warnings.append(f"candidates[{index}].primaryKeyword 不在关键词库: {primary}")
    return ValidationResult(ok=not issues, issues=issues, warnings=warnings)


def validate_article_data(article: Any, quality: Any) -> ValidationResult:
    article_result = validate_json_schema(article, "article")
    quality_result = validate_json_schema(quality, "quality")
    issues = [f"article.{issue}" for issue in article_result.issues]
    issues.extend(f"quality.{issue}" for issue in quality_result.issues)
    markdown = article.get("articleMarkdown") if isinstance(article, dict) else ""
    if isinstance(markdown, str) and "Rufus 时代" in markdown:
        issues.append('article.articleMarkdown 含过期口径 "Rufus 时代"')
    return ValidationResult(ok=not issues, issues=issues)


def validate_fact_check_data(data: Any) -> ValidationResult:
    result = validate_json_schema(data, "fact_check")
    return ValidationResult(ok=not result.issues, issues=list(result.issues))


def fact_check_summary(data: Any) -> dict[str, int]:
    summary = {"claims": 0, "highRisk": 0, "mediumRisk": 0, "sourceNeeded": 0, "mustFix": 0}
    if isinstance(data, dict) and isinstance(data.get("claims"), list):
        summary["claims"] = len(data["claims"])
        summary["highRisk"] = len([c for c in data["claims"] if c.get("risk") == "high"])
        summary["mediumRisk"] = len([c for c in data["claims"] if c.get("risk") == "medium"])
        summary["sourceNeeded"] = len([c for c in data["claims"] if c.get("sourceNeeded")])
        summary["mustFix"] = len(data.get("mustFixBeforePublish") or [])
    return summary


def validate_score_set_data(data: Any) -> ValidationResult:
    issues: list[str] = []
    if not isinstance(data, dict):
        return ValidationResult(False, ["score set 不是对象"])
    for key, schema in [("seo", "seo_score"), ("geo", "geo_score"), ("dual", "dual_quality")]:
        result = validate_json_schema(data.get(key), schema)
        issues.extend(f"{key}.{issue}" for issue in result.issues)
    return ValidationResult(ok=not issues, issues=issues)


def validate_channel_data(data: Any, channel: str) -> ValidationResult:
    result = validate_json_schema(data, "channel_outputs")
    issues = list(result.issues)
    if isinstance(data, dict) and data.get("channel") != channel:
        issues.append(f"channel 应为 {channel}")
    if channel == "xiaohongshu" and isinstance(data, dict) and len(data.get("titleCandidates") or []) < 5:
        issues.append("xiaohongshu titleCandidates 至少 5 个")
    return ValidationResult(ok=not issues, issues=issues)


def validate_article_quality_data(data: Any) -> ValidationResult:
    result = validate_json_schema(data, "article_quality_score")
    issues = list(result.issues)
    if isinstance(data, dict):
        score = round(float(data.get("articleQualityScore") or 0))
        breakdown = data.get("breakdown") or {}
        parts = ["sellerPainFit", "actionability", "informationGain", "originality", "clarity", "evidenceUse", "businessUsefulness"]
        total = sum(float(breakdown.get(part) or 0) for part in parts)
        if abs(score - round(total)) > 2:
            issues.append(f"articleQualityScore 与 breakdown 合计不一致: score={score}, breakdown={round(total)}")
    return ValidationResult(ok=not issues, issues=issues)


def validate_source_resolution_data(data: Any, article_id: str | None = None) -> ValidationResult:
    result = validate_json_schema(data, "source_resolution")
    issues = list(result.issues)
    if article_id and isinstance(data, dict) and data.get("articleId") != article_id:
        issues.append(f"articleId 应为 {article_id}")
    return ValidationResult(ok=not issues, issues=issues)


def source_resolution_summary(data: Any) -> dict[str, int]:
    summary = {"items": 0, "resolved": 0, "partiallyResolved": 0, "notFound": 0, "manualReview": 0}
    if not isinstance(data, dict):
        return summary
    items = data.get("items") or []
    summary["items"] = len(items)
    for item in items:
        status = item.get("resolvedStatus")
        if status == "resolved":
            summary["resolved"] += 1
        elif status == "partially_resolved":
            summary["partiallyResolved"] += 1
        elif status == "not_found":
            summary["notFound"] += 1
        elif status == "needs_manual_review":
            summary["manualReview"] += 1
    return summary


def validate_revised_article_data(data: Any, original_article: dict[str, Any] | None = None, resolution: dict[str, Any] | None = None) -> ValidationResult:
    result = validate_json_schema(data, "revised_article")
    issues = list(result.issues)
    warnings: list[str] = []
    if isinstance(data, dict) and original_article:
        if data.get("slug") != original_article.get("slug"):
            issues.append("slug 不得在修订中变更")
        if data.get("primaryKeyword") != original_article.get("primaryKeyword"):
            issues.append("primaryKeyword 不得在修订中变更")
    if isinstance(data, dict) and resolution:
        unresolved = [
            item for item in resolution.get("items", [])
            if item.get("resolvedStatus") not in {"resolved", "partially_resolved"}
        ]
        if unresolved:
            warnings.append(f"source_resolution 仍有 {len(unresolved)} 条未解决，修订后需人工复核")
    return ValidationResult(ok=not issues, issues=issues, warnings=warnings)


def validate_content_classification_data(data: Any) -> ValidationResult:
    result = validate_json_schema(data, "content_classification")
    return ValidationResult(ok=not result.issues, issues=list(result.issues))
