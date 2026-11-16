"""Rule management API defined by policy-and-audit.md §4."""

from __future__ import annotations

import re
import sqlite3
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response, status

from skill_observability.db import Storage
from skill_observability.engine import PolicyEngine
from skill_observability.constants import ACTION_AUDIT, ACTION_BLOCK

_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{2,63}$")
_CATEGORIES = {"pii", "dangerous_command", "tool_denylist", "custom"}
_ACTIONS = {ACTION_BLOCK, ACTION_AUDIT}
_FLAGS = {"i", "m", "s"}
_MISSING = object()


def build_rules_router(storage: Storage, engine: PolicyEngine) -> APIRouter:
    router = APIRouter()

    @router.get("/api/rules")
    async def list_rules() -> dict:
        return {"items": storage.list_rules()}

    @router.post("/api/rules", status_code=status.HTTP_201_CREATED)
    async def create_rule(request: Request) -> dict:
        payload = await _read_payload(request)
        rule = _validate_rule(payload)
        with storage.rule_update_lock:
            try:
                created, version = storage.create_rule(rule)
            except sqlite3.IntegrityError as exc:
                if "UNIQUE constraint failed: rule.id" in str(exc):
                    raise _error(409, "rule id already exists") from exc
                raise
            _reload(engine, storage, version)
        return created

    @router.put("/api/rules/{rule_id}")
    async def replace_rule(rule_id: str, request: Request) -> dict:
        payload = await _read_payload(request)
        if not isinstance(payload, dict) or payload.get("id") != rule_id:
            raise _error(422, "body.id must match path id")
        rule = _validate_rule(payload)
        with storage.rule_update_lock:
            updated, version = storage.replace_rule(rule_id, rule)
            if updated is None:
                raise _error(404, "rule not found")
            _reload(engine, storage, version)
        return updated

    @router.delete("/api/rules/{rule_id}", status_code=status.HTTP_204_NO_CONTENT)
    async def delete_rule(rule_id: str) -> Response:
        with storage.rule_update_lock:
            version = storage.delete_rule(rule_id)
            if version is None:
                raise _error(404, "rule not found")
            _reload(engine, storage, version)
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    return router


async def _read_payload(request: Request) -> Any:
    try:
        return await request.json()
    except Exception as exc:
        raise _error(422, "request body must be a JSON object") from exc


def _validate_rule(payload: Any) -> dict:
    if not isinstance(payload, dict):
        raise _error(422, "request body must be a JSON object")

    rule_id = payload.get("id", _MISSING)
    if not isinstance(rule_id, str) or _ID_PATTERN.fullmatch(rule_id) is None:
        raise _error(422, "id must match the rule slug pattern")

    name = payload.get("name", _MISSING)
    if not isinstance(name, str):
        raise _error(422, "name must be a string")

    category = payload.get("category", _MISSING)
    if not isinstance(category, str) or category not in _CATEGORIES:
        raise _error(422, "category is invalid")

    action = payload.get("action", _MISSING)
    if not isinstance(action, str) or action not in _ACTIONS:
        raise _error(422, "action is invalid")

    enabled = payload.get("enabled", True)
    if not isinstance(enabled, bool):
        raise _error(422, "enabled must be a boolean")

    priority = payload.get("priority", 100)
    if isinstance(priority, bool) or not isinstance(priority, int):
        raise _error(422, "priority must be an integer")

    agent_ids = _validate_string_list(payload.get("agent_ids"), "agent_ids")
    tool_names = _validate_string_list(payload.get("tool_names"), "tool_names")
    args_regex = _validate_args_regex(payload.get("args_regex"))

    if not tool_names and args_regex is None:
        raise _error(422, "tool_names or args_regex is required")

    description = payload.get("description")
    if description is not None and not isinstance(description, str):
        raise _error(422, "description must be a string or null")

    return {
        "id": rule_id,
        "name": name,
        "category": category,
        "action": action,
        "enabled": enabled,
        "priority": priority,
        "agent_ids": agent_ids,
        "tool_names": tool_names,
        "args_regex": args_regex,
        "description": description,
    }


def _validate_string_list(value: Any, field: str) -> list[str] | None:
    if value is None:
        return None
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise _error(422, f"{field} must be a string array or null")
    return value


def _validate_args_regex(value: Any) -> dict | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise _error(422, "args_regex must be an object or null")

    pattern = value.get("pattern", _MISSING)
    if not isinstance(pattern, str) or not pattern:
        raise _error(422, "args_regex.pattern must be a non-empty string")

    flags = value.get("flags", "i")
    if (
        not isinstance(flags, str)
        or not flags
        or set(flags) - _FLAGS
        or len(set(flags)) != len(flags)
    ):
        raise _error(422, "args_regex.flags must be a unique combination of i, m, s")

    fields = value.get("fields", _MISSING)
    if fields is not _MISSING and fields is not None and (
        not isinstance(fields, list) or not all(isinstance(item, str) for item in fields)
    ):
        raise _error(422, "args_regex.fields must be a string array")

    try:
        re.compile(pattern, _regex_flags(flags))
    except re.error as exc:
        raise _error(422, "args_regex.pattern cannot be compiled") from exc
    return {"pattern": pattern, "flags": flags, **({"fields": fields} if fields is not _MISSING else {})}


def _regex_flags(flags: str) -> int:
    return sum({"i": re.IGNORECASE, "m": re.MULTILINE, "s": re.DOTALL}[char] for char in flags)


def _reload(engine: PolicyEngine, storage: Storage, version: int) -> None:
    engine.reload(storage.load_rule_rows(), version)


def _error(code: int, detail: str) -> HTTPException:
    return HTTPException(status_code=code, detail=detail)
