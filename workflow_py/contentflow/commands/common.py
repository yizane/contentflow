from __future__ import annotations

import json
from datetime import date, datetime
from typing import Any

import typer


def json_default(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(value, date):
        return value.isoformat()
    return str(value)


def print_json(payload: dict[str, Any], *, exit_code: int = 0) -> None:
    typer.echo(json.dumps(payload, ensure_ascii=False, indent=2, default=json_default))
    if exit_code:
        raise typer.Exit(exit_code)


def handle_error(exc: Exception) -> None:
    print_json({"ok": False, "error": str(exc)}, exit_code=1)
