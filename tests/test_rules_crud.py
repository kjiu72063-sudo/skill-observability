import json
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from skill_observability.api import build_rules_router
from skill_observability.app import create_app
from skill_observability.db import Storage
from skill_observability.engine import EvalContext, PolicyEngine
from skill_observability.sse import EventHub


ROOT = Path(__file__).parents[1]


@pytest.fixture
def deps(tmp_path):
    storage = Storage(tmp_path / "rules.sqlite")
    seed = json.loads((ROOT / "seed" / "rules.json").read_text(encoding="utf-8"))
    assert storage.seed_rules_if_empty(seed, time.time_ns()) == 4
    engine = PolicyEngine()
    engine.reload(storage.load_rule_rows(), storage.get_rules_version())
    app = create_app(storage, engine, EventHub())
    with TestClient(app) as client:
        yield storage, engine, client


def rule_payload(rule_id="z-rule-01", **overrides):
    payload = {
        "id": rule_id,
        "name": "测试规则",
        "category": "custom",
        "action": "block",
        "enabled": True,
        "priority": 50,
        "agent_ids": None,
        "tool_names": ["query_user_db"],
        "args_regex": None,
        "description": "用于规则 API 测试",
    }
    payload.update(overrides)
    return payload


def evaluate(engine, tool_name="query_user_db"):
    return engine.evaluate(tool_name, {}, EvalContext("customer-service", "t" * 32, "s" * 16))


def test_get_rules_returns_sorted_complete_objects_and_string_timestamps(deps):
    storage, engine, client = deps
    response = client.get("/api/rules")
    assert response.status_code == 200
    items = response.json()["items"]
    assert len(items) == 4
    assert [(item["priority"], item["id"]) for item in items] == sorted(
        (item["priority"], item["id"]) for item in items
    )
    expected = {
        "id", "name", "category", "action", "enabled", "priority", "agent_ids",
        "tool_names", "args_regex", "description", "created_at_unix_nano",
        "updated_at_unix_nano",
    }
    assert set(items[0]) == expected
    assert all(isinstance(item["created_at_unix_nano"], str) for item in items)
    assert all(isinstance(item["updated_at_unix_nano"], str) for item in items)
    assert storage.get_rules_version() == engine.loaded_version == 1


def test_get_rules_includes_disabled(deps):
    storage, engine, client = deps
    body = client.get("/api/rules").json()["items"]
    target = next(item for item in body if item["id"] == "r3-tool-denylist")
    response = client.put("/api/rules/r3-tool-denylist", json={**target, "enabled": False})
    assert response.status_code == 200
    assert response.json()["enabled"] is False
    listed = client.get("/api/rules").json()["items"]
    assert next(item for item in listed if item["id"] == "r3-tool-denylist")["enabled"] is False
    assert storage.get_rules_version() == engine.loaded_version == 2


def test_post_returns_201_and_duplicate_is_409_without_version_change(deps):
    storage, engine, client = deps
    response = client.post("/api/rules", json=rule_payload())
    assert response.status_code == 201
    assert response.json()["id"] == "z-rule-01"
    assert storage.get_rules_version() == engine.loaded_version == 2
    duplicate = client.post("/api/rules", json=rule_payload())
    assert duplicate.status_code == 409
    assert duplicate.json() == {"detail": "rule id already exists"}
    assert storage.get_rules_version() == engine.loaded_version == 2


@pytest.mark.parametrize(
    "change",
    [
        {"id": "Bad"},
        {"category": "other"},
        {"action": "warn"},
        {"enabled": "true"},
        {"priority": True},
        {"agent_ids": [1]},
        {"tool_names": [1]},
        {"args_regex": []},
        {"args_regex": {"pattern": 1}},
        {"args_regex": {"pattern": "x", "flags": "ii"}},
        {"args_regex": {"pattern": "x", "flags": "q"}},
        {"args_regex": {"pattern": "("}},
        {"args_regex": {"pattern": "x", "fields": [1]}},
        {"tool_names": None, "args_regex": None},
    ],
)
def test_post_validation_errors_do_not_write(change, deps):
    storage, engine, client = deps
    response = client.post("/api/rules", json=rule_payload(**change))
    assert response.status_code == 422
    assert set(response.json()) == {"detail"}
    assert storage.get_rules_version() == engine.loaded_version == 1
    assert all(item["id"] != "z-rule-01" for item in client.get("/api/rules").json()["items"])


def test_put_is_full_replace_and_enabled_is_applied(deps):
    storage, engine, client = deps
    original = next(item for item in client.get("/api/rules").json()["items"] if item["id"] == "r3-tool-denylist")
    replacement = {**original, "name": "已替换", "enabled": False, "priority": 7}
    response = client.put("/api/rules/r3-tool-denylist", json=replacement)
    assert response.status_code == 200
    assert response.json()["name"] == "已替换"
    assert response.json()["enabled"] is False
    assert response.json()["priority"] == 7
    assert response.json()["created_at_unix_nano"] == original["created_at_unix_nano"]
    assert storage.get_rules_version() == engine.loaded_version == 2


def test_put_accepts_seed_rule_round_trip_with_nullable_fields(deps):
    storage, engine, client = deps
    original = next(item for item in client.get("/api/rules").json()["items"] if item["id"] == "r1-pii-id-card")
    response = client.put("/api/rules/r1-pii-id-card", json=original)
    assert response.status_code == 200
    assert response.json()["args_regex"]["fields"] is None
    assert storage.get_rules_version() == engine.loaded_version == 2


def test_put_mismatch_invalid_regex_and_missing_rule(deps):
    storage, engine, client = deps
    original = next(item for item in client.get("/api/rules").json()["items"] if item["id"] == "r3-tool-denylist")
    mismatch = client.put("/api/rules/r3-tool-denylist", json={**original, "id": "other-rule"})
    assert mismatch.status_code == 422
    invalid = client.put(
        "/api/rules/r3-tool-denylist",
        json={**original, "args_regex": {"pattern": "("}, "tool_names": None},
    )
    assert invalid.status_code == 422
    missing = client.put("/api/rules/not-found-rule", json=rule_payload("not-found-rule"))
    assert missing.status_code == 404
    assert storage.get_rules_version() == engine.loaded_version == 1


def test_delete_is_hard_delete_and_missing_is_404(deps):
    storage, engine, client = deps
    response = client.delete("/api/rules/r3-tool-denylist")
    assert response.status_code == 204
    assert response.content == b""
    assert all(item["id"] != "r3-tool-denylist" for item in client.get("/api/rules").json()["items"])
    assert storage.get_rules_version() == engine.loaded_version == 2
    missing = client.delete("/api/rules/r3-tool-denylist")
    assert missing.status_code == 404
    assert storage.get_rules_version() == engine.loaded_version == 2


def test_hot_reload_post_put_delete_changes_next_evaluation(deps):
    storage, engine, client = deps
    assert evaluate(engine).verdict == "allow"
    created = client.post("/api/rules", json=rule_payload()).json()
    assert created["id"] == "z-rule-01"
    assert storage.get_rules_version() == engine.loaded_version == 2
    assert evaluate(engine).verdict == "block"

    current = next(item for item in client.get("/api/rules").json()["items"] if item["id"] == "z-rule-01")
    assert client.put("/api/rules/z-rule-01", json={**current, "enabled": False}).status_code == 200
    assert storage.get_rules_version() == engine.loaded_version == 3
    assert evaluate(engine).verdict == "allow"

    assert client.delete("/api/rules/z-rule-01").status_code == 204
    assert storage.get_rules_version() == engine.loaded_version == 4
    assert evaluate(engine).verdict == "allow"


def test_failed_write_keeps_old_snapshot_and_version(deps):
    storage, engine, client = deps
    assert client.post("/api/rules", json=rule_payload()).status_code == 201
    before_version = storage.get_rules_version()
    before_verdict = evaluate(engine)
    response = client.put(
        "/api/rules/z-rule-01",
        json={**rule_payload(), "args_regex": {"pattern": "["}, "tool_names": None},
    )
    assert response.status_code == 422
    assert storage.get_rules_version() == engine.loaded_version == before_version
    assert evaluate(engine) == before_verdict


def test_seed_is_idempotent_and_load_shape_is_unchanged(tmp_path):
    storage = Storage(tmp_path / "seed.sqlite")
    seed = json.loads((ROOT / "seed" / "rules.json").read_text(encoding="utf-8"))
    now = time.time_ns()
    assert storage.seed_rules_if_empty(seed, now) == 4
    assert storage.seed_rules_if_empty(seed, now + 1) == 0
    assert storage.get_rules_version() == 1
    rows = storage.load_rule_rows()
    assert len(rows) == 4
    assert set(rows[0]) == {
        "id", "name", "category", "action", "enabled", "priority", "agent_ids",
        "tool_names", "args_regex", "description",
    }


def test_rules_router_is_exported():
    assert callable(build_rules_router)
