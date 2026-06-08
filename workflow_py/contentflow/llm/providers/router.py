from __future__ import annotations

from dataclasses import dataclass
from collections.abc import Callable
from typing import Any

from contentflow.core import config
from contentflow.llm.providers import openclaw_cli

BUILTIN_PROVIDERS: dict[str, dict[str, Any]] = {
    "openclaw_cli": {"type": "cli", "command": "openclaw", "enabled": True},
}


@dataclass(slots=True)
class ProviderRoute:
    provider_key: str
    provider_cfg: dict[str, Any]
    model: str | None
    entry: dict[str, Any]


@dataclass(slots=True)
class ProviderResult:
    ok: bool
    error: str | None
    visible_text: str | None
    raw: Any
    duration_ms: int


def normalize_provider_key(key: str | None) -> str:
    if key == "openclaw":
        return "openclaw_cli"
    return key or "openclaw_cli"


def load_models_config() -> dict[str, Any]:
    cfg = config.read_yaml("models")
    providers = dict(BUILTIN_PROVIDERS)
    for key, value in (cfg.get("providers") or {}).items():
        normalized = normalize_provider_key(key)
        providers[normalized] = {**providers.get(normalized, {}), **(value or {})}
    cfg["providers"] = providers
    return cfg


def resolve_route(task_type: str) -> ProviderRoute:
    cfg = load_models_config()
    candidates = cfg.get(task_type) or []
    entry = next((item for item in candidates if item.get("enabled") is not False), None) if isinstance(candidates, list) else None
    default = cfg.get("default") or {}
    provider_key = normalize_provider_key((entry or {}).get("provider") or default.get("provider"))
    provider_cfg = cfg["providers"].get(provider_key)
    if not provider_cfg:
        raise ValueError(f"未知执行器: {provider_key}")
    return ProviderRoute(
        provider_key=provider_key,
        provider_cfg=provider_cfg,
        model=(entry or {}).get("model") or default.get("model"),
        entry=entry or {},
    )


def run_task(*, task_type: str, message: str, session_key: str, timeout_sec: int = 900, route: ProviderRoute | None = None, progress_callback: Callable[[dict[str, Any]], None] | None = None) -> ProviderResult:
    selected = route or resolve_route(task_type)
    if selected.provider_cfg.get("enabled") is False:
        return ProviderResult(False, f"执行器 {selected.provider_key} 未启用（models.yaml providers.{selected.provider_key}.enabled: false）", None, None, 0)
    if selected.provider_key != "openclaw_cli":
        return ProviderResult(False, f"当前 Python runtime 仅支持 openclaw_cli，收到: {selected.provider_key}", None, None, 0)
    result = openclaw_cli.run(
        provider_cfg=selected.provider_cfg,
        model=selected.model,
        message=message,
        session_key=session_key,
        timeout_sec=timeout_sec,
        entry=selected.entry,
        progress_callback=progress_callback,
    )
    return ProviderResult(result["ok"], result["error"], result["visibleText"], result["raw"], result["durationMs"])
