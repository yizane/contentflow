from __future__ import annotations

import typer

from contentflow.commands.common import handle_error, print_json
from contentflow.core import db

app = typer.Typer(add_completion=False, no_args_is_help=True)


@app.command("path")
def env_path() -> None:
    try:
        print_json({"ok": True, "envPath": str(db.ROOT / ".env")})
    except Exception as exc:
        handle_error(exc)

