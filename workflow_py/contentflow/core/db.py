from __future__ import annotations

import hashlib
import json
import os
import secrets
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pymysql
import sqlparse
from dotenv import load_dotenv as load_dotenv_file
from pydantic import ValidationError, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from contentflow.flow import runtime

ROOT = Path(__file__).resolve().parents[3]


class MissingMySQLConfig(RuntimeError):
    pass


def load_dotenv() -> None:
    env_path = ROOT / ".env"
    if env_path.exists():
        load_dotenv_file(env_path, override=False)


class MySQLSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=ROOT / ".env",
        env_prefix="MYSQL_",
        extra="ignore",
        case_sensitive=False,
    )

    host: str
    port: int = 3306
    database: str
    user: str
    password: str
    ssl: bool = False
    connection_limit: int = 5

    @field_validator("host", "database", "user", "password")
    @classmethod
    def must_not_be_blank(cls, value: str) -> str:
        if not str(value or "").strip():
            raise ValueError("blank")
        return value


@dataclass(slots=True)
class MySQLConfig:
    host: str
    port: int
    database: str
    user: str
    password: str
    ssl: bool = False
    connection_limit: int = 5


def config_from_env(*, load_env_file: bool = True) -> MySQLConfig:
    if load_env_file:
        load_dotenv()
    try:
        settings = MySQLSettings()
    except ValidationError as exc:
        missing: list[str] = []
        fields = {
            "host": "MYSQL_HOST",
            "database": "MYSQL_DATABASE",
            "user": "MYSQL_USER",
            "password": "MYSQL_PASSWORD",
        }
        for err in exc.errors():
            loc = err.get("loc") or []
            if loc:
                key = fields.get(str(loc[0]))
                if key:
                    missing.append(key)
        missing = sorted(set(missing)) or ["MYSQL_HOST", "MYSQL_DATABASE", "MYSQL_USER", "MYSQL_PASSWORD"]
        raise MissingMySQLConfig(f"MySQL 未配置（缺环境变量: {', '.join(missing)}）。本项目不 fallback SQLite。") from exc
    return MySQLConfig(
        host=settings.host,
        port=settings.port,
        database=settings.database,
        user=settings.user,
        password=settings.password,
        ssl=settings.ssl,
        connection_limit=settings.connection_limit,
    )


def connect(config: MySQLConfig | None = None):
    cfg = config or config_from_env()
    return pymysql.connect(
        host=cfg.host,
        port=cfg.port,
        database=cfg.database,
        user=cfg.user,
        password=cfg.password,
        charset="utf8mb4",
        autocommit=True,
        cursorclass=pymysql.cursors.DictCursor,
        ssl={} if cfg.ssl else None,
    )


class Database:
    def __init__(self, config: MySQLConfig | None = None):
        self.config = config

    def query(self, sql: str, params: list[Any] | tuple[Any, ...] | None = None) -> list[dict[str, Any]]:
        with connect(self.config) as conn:
            with conn.cursor() as cur:
                cur.execute(sql, params or [])
                rows = cur.fetchall()
                return list(rows)

    def exec(self, sql: str) -> None:
        with connect(self.config) as conn:
            with conn.cursor() as cur:
                for stmt in split_sql_statements(sql):
                    cur.execute(stmt)

    def insert(self, table: str, data: dict[str, Any]) -> None:
        cols = list(data.keys())
        values = [_serialize(v) for v in data.values()]
        placeholders = ", ".join(["%s"] * len(cols))
        col_sql = ", ".join(cols)
        self.query(f"INSERT INTO {table} ({col_sql}) VALUES ({placeholders})", values)

    def update(self, table: str, data: dict[str, Any], where_sql: str, where_params: list[Any] | None = None) -> None:
        cols = list(data.keys())
        values = [_serialize(v) for v in data.values()]
        set_sql = ", ".join([f"{col} = %s" for col in cols])
        self.query(f"UPDATE {table} SET {set_sql} WHERE {where_sql}", [*values, *(where_params or [])])


def _serialize(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return value


def split_sql_statements(sql: str) -> list[str]:
    return [stmt.strip() for stmt in sqlparse.split(sql) if stmt.strip()]


def query(sql: str, params: list[Any] | tuple[Any, ...] | None = None) -> list[dict[str, Any]]:
    return Database().query(sql, params)


def insert(table: str, data: dict[str, Any]) -> None:
    Database().insert(table, data)


def update(table: str, data: dict[str, Any], where_sql: str, where_params: list[Any] | None = None) -> None:
    Database().update(table, data, where_sql, where_params)


def as_json(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return None


def now() -> str:
    return runtime.mysql_datetime(os.environ.get("ENGINE_NOW"))


def make_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(6)}"


def make_run_id(prefix: str = "run") -> str:
    d = runtime.business_datetime_from_date(runtime.engine_now_date(os.environ.get("ENGINE_NOW")))
    return f"{prefix}_{d:%Y%m%d}_{d:%H%M%S}_{secrets.token_hex(2)}"


def sha256(text: str | None) -> str:
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()


def record_model_run(fields: dict[str, Any], *, db_client: Any | None = None) -> str:
    database = db_client or Database()
    model_run_id = make_id("mrun")
    database.insert("model_runs", {
        "id": model_run_id,
        "engine_run_id": fields.get("engineRunId"),
        "article_id": fields.get("articleId"),
        "article_version_id": fields.get("articleVersionId"),
        "task_type": fields.get("taskType"),
        "model_provider": fields.get("provider"),
        "model_name": fields.get("model"),
        "openclaw_session_key": fields.get("sessionKey"),
        "task_prompt": fields.get("taskPrompt"),
        "raw_response": fields.get("rawResponse"),
        "parsed_output_json": fields.get("parsedOutput"),
        "status": fields.get("status"),
        "started_at": fields.get("startedAt"),
        "finished_at": now(),
        "error_message": fields.get("error"),
        "raw_summary_json": fields.get("rawSummary"),
    })
    return model_run_id


def ping() -> dict[str, Any]:
    rows = query("SELECT 1 ok")
    return {"ok": True, "result": rows[0]["ok"] if rows else None}


def init_schema() -> dict[str, Any]:
    schema_path = ROOT / "db" / "mysql_schema.sql"
    Database().exec(schema_path.read_text(encoding="utf-8"))
    return {"ok": True, "schema": str(schema_path.relative_to(ROOT))}


def migrate() -> dict[str, Any]:
    database = Database()
    migrations_dir = ROOT / "db" / "mysql_migrations"
    applied = {row["id"] for row in database.query("SELECT id FROM schema_migrations")}
    executed: list[str] = []
    for path in sorted(migrations_dir.glob("*.sql")):
        if path.name in applied:
            continue
        database.exec(path.read_text(encoding="utf-8"))
        database.insert("schema_migrations", {"id": path.name, "executed_at": now()})
        executed.append(path.name)
    return {"ok": True, "executed": executed}
