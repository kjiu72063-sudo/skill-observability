import json
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from threading import Event

import pytest
from fastapi.testclient import TestClient

from skill_observability.api import build_rules_router
from skill_observability.app import create_app
from skill_observability.db import Storage
from skill_observability.engine import EvalContext, PolicyEngine
from skill_observability.sse import EventHub


ROOT = Path(__file__).parents[1]


@dataclass
class RuleDeps:
    storage: Storage
    engine: PolicyEngine
    client: TestClient
    app: object


@pytest.fixture
def deps(tmp_path):
    storage = Storage(tmp_path / "rules.sqlite")
    seed = json.loads((ROOT / "seed" / "rules.json").read_text(encoding="utf-8"))
    assert storage.seed_rules_if_empty(seed, time.time_ns()) == 4
    engine = PolicyEngine()
    engine.reload(storage.load_rule_rows(), storage.get_rules_version())
    app = create_app(storage, engine, EventHub())
    with TestClient(app) as client:
        yield RuleDeps(storage=storage, engine=engine, client=client, app=app)


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
    response = deps.client.get("/api/rules")
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
    assert deps.storage.get_rules_version() == deps.engine.loaded_version == 1


def test_get_rules_includes_disabled(deps):
    body = deps.client.get("/api/rules").json()["items"]
    target = next(item for item in body if item["id"] == "r3-tool-denylist")
    response = deps.client.put("/api/rules/r3-tool-denylist", json={**target, "enabled": False})
    assert response.status_code == 200
    assert response.json()["enabled"] is False
    listed = deps.client.get("/api/rules").json()["items"]
    assert next(item for item in listed if item["id"] == "r3-tool-denylist")["enabled"] is False
    assert deps.storage.get_rules_version() == deps.engine.loaded_version == 2


def test_post_returns_201_and_duplicate_is_409_without_version_change(deps):
    response = deps.client.post("/api/rules", json=rule_payload())
    assert response.status_code == 201
    assert response.json()["id"] == "z-rule-01"
    assert deps.storage.get_rules_version() == deps.engine.loaded_version == 2
    duplicate = deps.client.post("/api/rules", json=rule_payload())
    assert duplicate.status_code == 409
    assert duplicate.json() == {"detail": "rule id already exists"}
    assert deps.storage.get_rules_version() == deps.engine.loaded_version == 2


@pytest.mark.parametrize(
    "change",
    [
        {"id": "Bad"},
        {"category": "other"},
        {"category": []},
        {"category": {}},
        {"action": "warn"},
        {"action": []},
        {"action": {}},
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
    response = deps.client.post("/api/rules", json=rule_payload(**change))
    assert response.status_code == 422
    assert set(response.json()) == {"detail"}
    assert deps.storage.get_rules_version() == deps.engine.loaded_version == 1
    assert all(item["id"] != "z-rule-01" for item in deps.client.get("/api/rules").json()["items"])


def test_put_is_full_replace_and_enabled_is_applied(deps):
    original = next(item for item in deps.client.get("/api/rules").json()["items"] if item["id"] == "r3-tool-denylist")
    replacement = {**original, "name": "已替换", "enabled": False, "priority": 7}
    response = deps.client.put("/api/rules/r3-tool-denylist", json=replacement)
    assert response.status_code == 200
    assert response.json()["name"] == "已替换"
    assert response.json()["enabled"] is False
    assert response.json()["priority"] == 7
    assert response.json()["created_at_unix_nano"] == original["created_at_unix_nano"]
    assert deps.storage.get_rules_version() == deps.engine.loaded_version == 2


def test_put_accepts_seed_rule_round_trip_with_nullable_fields(deps):
    original = next(item for item in deps.client.get("/api/rules").json()["items"] if item["id"] == "r1-pii-id-card")
    response = deps.client.put("/api/rules/r1-pii-id-card", json=original)
    assert response.status_code == 200
    assert response.json()["args_regex"]["fields"] is None
    assert deps.storage.get_rules_version() == deps.engine.loaded_version == 2


def test_put_mismatch_invalid_regex_and_missing_rule(deps):
    original = next(item for item in deps.client.get("/api/rules").json()["items"] if item["id"] == "r3-tool-denylist")
    mismatch = deps.client.put("/api/rules/r3-tool-denylist", json={**original, "id": "other-rule"})
    assert mismatch.status_code == 422
    invalid = deps.client.put(
        "/api/rules/r3-tool-denylist",
        json={**original, "args_regex": {"pattern": "("}, "tool_names": None},
    )
    assert invalid.status_code == 422
    missing = deps.client.put("/api/rules/not-found-rule", json=rule_payload("not-found-rule"))
    assert missing.status_code == 404
    assert deps.storage.get_rules_version() == deps.engine.loaded_version == 1


def test_delete_is_hard_delete_and_missing_is_404(deps):
    response = deps.client.delete("/api/rules/r3-tool-denylist")
    assert response.status_code == 204
    assert response.content == b""
    assert all(item["id"] != "r3-tool-denylist" for item in deps.client.get("/api/rules").json()["items"])
    assert deps.storage.get_rules_version() == deps.engine.loaded_version == 2
    missing = deps.client.delete("/api/rules/r3-tool-denylist")
    assert missing.status_code == 404
    assert deps.storage.get_rules_version() == deps.engine.loaded_version == 2


def test_hot_reload_post_put_delete_changes_next_evaluation(deps):
    assert evaluate(deps.engine).verdict == "allow"
    created = deps.client.post("/api/rules", json=rule_payload()).json()
    assert created["id"] == "z-rule-01"
    assert deps.storage.get_rules_version() == deps.engine.loaded_version == 2
    assert evaluate(deps.engine).verdict == "block"

    current = next(item for item in deps.client.get("/api/rules").json()["items"] if item["id"] == "z-rule-01")
    assert deps.client.put("/api/rules/z-rule-01", json={**current, "enabled": False}).status_code == 200
    assert deps.storage.get_rules_version() == deps.engine.loaded_version == 3
    assert evaluate(deps.engine).verdict == "allow"

    assert deps.client.delete("/api/rules/z-rule-01").status_code == 204
    assert deps.storage.get_rules_version() == deps.engine.loaded_version == 4
    assert evaluate(deps.engine).verdict == "allow"


def test_concurrent_posts_install_every_successful_rule_before_return(deps, monkeypatch):
    first_snapshot_loaded = Event()
    release_first_snapshot = Event()
    second_request_started = Event()
    second_request_finished = Event()
    original_load = deps.storage.load_rule_rows
    load_count = 0

    def delayed_load():
        nonlocal load_count
        rows = original_load()
        load_count += 1
        if load_count == 1:
            first_snapshot_loaded.set()
            assert release_first_snapshot.wait(timeout=5)
        return rows

    monkeypatch.setattr(deps.storage, "load_rule_rows", delayed_load)

    def post(client, rule_id, started=None, finished=None):
        if started is not None:
            started.set()
        response = client.post("/api/rules", json=rule_payload(rule_id))
        if finished is not None:
            finished.set()
        return response

    with TestClient(deps.app) as client_a, TestClient(deps.app) as client_b:
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(post, client_a, "race-rule-a")
            assert first_snapshot_loaded.wait(timeout=5)
            second = pool.submit(
                post, client_b, "race-rule-b", second_request_started, second_request_finished
            )
            assert second_request_started.wait(timeout=5)
            assert not second_request_finished.wait(timeout=0.25)
            release_first_snapshot.set()
            first_response = first.result(timeout=5)
            second_response = second.result(timeout=5)

    assert first_response.status_code == 201
    assert second_response.status_code == 201
    assert deps.storage.get_rules_version() == deps.engine.loaded_version == 3
    assert deps.engine.rule_by_id("race-rule-a") is not None
    assert deps.engine.rule_by_id("race-rule-b") is not None


def test_failed_write_keeps_old_snapshot_and_version(deps):
    assert deps.client.post("/api/rules", json=rule_payload()).status_code == 201
    before_version = deps.storage.get_rules_version()
    before_verdict = evaluate(deps.engine)
    response = deps.client.put(
        "/api/rules/z-rule-01",
        json={**rule_payload(), "args_regex": {"pattern": "["}, "tool_names": None},
    )
    assert response.status_code == 422
    assert deps.storage.get_rules_version() == deps.engine.loaded_version == before_version
    assert evaluate(deps.engine) == before_verdict


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
