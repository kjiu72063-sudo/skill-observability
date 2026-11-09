"""M1 垂直切片冒烟机验（issue #14；断言逐条对应 #10 决议机验 6–9，不自造）。

- 不走 demo.py 交互循环：进程内独立装配（tmp SQLite + 种子 4 条 + 引擎启动加载），
  ``TestClient`` 打 ASGI app，直接调用可导入的场景入口
  :func:`scenario.customer_service.agent.run_customer_service_turn`。
- replay 档（vcr cassette ``record_mode="none"``）：零网络、零密钥、可重复。
- 覆盖路径包含 #12/#13 修过的缺陷位：观察期 span 标记（#12 评审缺陷）、
  audit payload 字节截断（#12 评审缺陷）、含点键的 ``blocked`` json_extract 路径
  （#13 bug）。
- 只覆盖本票验收，不为地图 fog「测试策略与 CI」定全局（#10 原文）。
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from scenario.customer_service.agent import run_customer_service_turn
from scenario.customer_service.config import CASSETTE_PATH, DEMO_USER_MESSAGE, MODEL
from scenario.customer_service.llm import ReplayLlmClient
from skill_observability.app import create_app
from skill_observability.db import Storage
from skill_observability.engine import PolicyEngine
from skill_observability.sdk import ObservabilitySdk, PolicyBlocked
from skill_observability.sse import EventHub

BASE_DIR = Path(__file__).resolve().parent.parent
SEED_PATH = BASE_DIR / "seed" / "rules.json"

# 场景三拍的三个工具调用（树三层 ×3 → 7 span）
SPAN_COUNT_PER_RUN = 7


# ---------------------------------------------------------------- 装配（demo bootstrap 同构，进程隔离）

class _Deps:
    """测试进程内装配：tmp 库、种子播种、引擎启动加载——与 demo.py DemoDeps 同构。"""

    def __init__(self, tmp_path: Path):
        self.storage = Storage(tmp_path / "test.db")
        seed = json.loads(SEED_PATH.read_text(encoding="utf-8"))
        self.storage.seed_rules_if_empty(seed, time.time_ns())
        self.engine = PolicyEngine()
        self.engine.reload(self.storage.load_rule_rows(), self.storage.get_rules_version())
        self.hub = EventHub()
        self.sdk = ObservabilitySdk(self.storage, self.engine, self.hub)
        self.llm = ReplayLlmClient(CASSETTE_PATH, model=MODEL)


@pytest.fixture()
def deps(tmp_path) -> _Deps:
    return _Deps(tmp_path)


@pytest.fixture()
def run(deps) -> dict:
    """跑一遍三拍全程（allow → 观察期 → block → 终止报告），返回结构化结果。"""
    run_start = time.time_ns()
    result = run_customer_service_turn(deps.sdk, deps.llm, DEMO_USER_MESSAGE)
    return {
        "trace_id": result.trace_id,
        "answer": result.answer,
        "deps": deps,
        "run_start": run_start,
    }


@pytest.fixture()
def spans_by_id(run) -> dict:
    """本 trace 全部 span，按 span_id 索引（经查询 API 拉回，端到端真实）。"""
    deps = run["deps"]
    client = TestClient(create_app(deps.storage, deps.engine, deps.hub))
    resp = client.get(f"/api/traces/{run['trace_id']}")
    assert resp.status_code == 200
    return {s["span_id"]: s for s in resp.json()["spans"]}


# ---------------------------------------------------------------- 机验6（#10 条目6）：span 表

class TestSpanTable:
    """机验6：树形父子正确；block/观察期/allow 未命中三态属性正确。"""

    def test_tree_shape_three_layers(
        self, run, spans_by_id  # 机验6：树形父子正确
    ):
        # 树 = 1 根 invoke_agent + 3 个 chat（父=根）+ 3 个 execute_tool（父=各自 chat）
        assert len(spans_by_id) == SPAN_COUNT_PER_RUN
        roots = [s for s in spans_by_id.values() if s["parent_span_id"] is None]
        assert len(roots) == 1
        root = roots[0]
        assert root["name"] == "invoke_agent customer-service"
        assert root["trace_id"] == run["trace_id"]

        chats = [s for s in spans_by_id.values()
                 if s["parent_span_id"] == root["span_id"]]
        assert len(chats) == 3
        assert all(s["name"].startswith("chat ") for s in chats)
        assert all(s["kind"] == "CLIENT" for s in chats)

        tools = [s for s in spans_by_id.values()
                 if s["parent_span_id"] in {c["span_id"] for c in chats}]
        assert len(tools) == 3
        assert all(s["name"].startswith("execute_tool ") for s in tools)
        # trace_id 全树一致（#8 决议 2：根生成、全程继承）
        assert all(s["trace_id"] == run["trace_id"] for s in spans_by_id.values())

    def test_block_span_attributes(
        self, run, spans_by_id  # 机验6：block span error.type="policy.block" + verdict=block
    ):
        blocked = [s for s in spans_by_id.values()
                   if s["attributes"].get("error.type") == "policy.block"]
        assert len(blocked) == 1
        span = blocked[0]
        attrs = span["attributes"]
        assert attrs["skill_observability.verdict"] == "block"
        assert attrs["skill_observability.matched_rule"] == "r1-pii-id-card"
        assert "skill_observability.block_reason" in attrs
        # 状态承载拦截语义（#13 实现备注：ERROR 在被拦的那次调用上）
        assert span["status_code"] == "ERROR"
        assert span["name"] == "execute_tool verify_customer_id"

    def test_observation_span_attributes(
        self, run, spans_by_id  # 机验6：观察期命中 span verdict=allow + matched_rule=r1b 且 status UNSET
    ):
        observed = [s for s in spans_by_id.values()
                    if s["attributes"].get("skill_observability.matched_rule") == "r1b-pii-phone-audit"]
        assert len(observed) == 1
        span = observed[0]
        attrs = span["attributes"]
        assert attrs["skill_observability.verdict"] == "allow"
        assert "error.type" not in attrs
        assert span["status_code"] == "UNSET"  # 观察期命中不拦：status 保持 UNSET
        assert span["name"] == "execute_tool query_contact_by_phone"

    def test_allow_miss_span_has_no_verdict(
        self, run, spans_by_id  # 机验6：allow 未命中 span 无 verdict 属性
    ):
        miss = [s for s in spans_by_id.values()
                if s["name"] == "execute_tool query_user_db"]
        assert len(miss) == 1
        attrs = miss[0]["attributes"]
        assert "skill_observability.verdict" not in attrs
        assert "skill_observability.matched_rule" not in attrs
        assert miss[0]["status_code"] == "UNSET"


# ---------------------------------------------------------------- 机验7（#10 条目7）：audit 表 + event_log

class TestAuditTable:
    """机验7：audit 三行语义正确（verdict/rule_id/payload/trace 关联）；event_log = span×2。"""

    def test_audit_three_rows(self, run, spans_by_id):
        deps = run["deps"]
        client = TestClient(create_app(deps.storage, deps.engine, deps.hub))
        items, total = deps.storage.list_audits(
            verdict=None, agent_id=None, tool_name=None, rule_id=None,
            from_ns=run["run_start"], to_ns=None, page=1, page_size=100,
        )
        assert total == 3  # 机验7：三行语义——恰三行（重跑不翻倍由 demo 生命周期保证）
        by_tool = {a["tool_name"]: a for a in items}

        # ① 查订单 allow、rule_id=NULL（#10 人验4①）
        a1 = by_tool["query_user_db"]
        assert a1["verdict"] == "allow"
        assert a1["rule_id"] is None and a1["action"] is None
        assert a1["payload"] == {"order_id": "20241025001"}
        assert a1["trace_id"] == run["trace_id"] and a1["span_id"] in spans_by_id

        # ② 手机号 allow + r1b（观察期）（#10 人验4②）
        a2 = by_tool["query_contact_by_phone"]
        assert a2["verdict"] == "allow"
        assert a2["rule_id"] == "r1b-pii-phone-audit"
        assert a2["action"] == "audit"
        assert a2["payload"] == {"phone": "13812345678"}
        assert a2["trace_id"] == run["trace_id"]

        # ③ 身份证 block + r1（#10 人验4③）
        a3 = by_tool["verify_customer_id"]
        assert a3["verdict"] == "block"
        assert a3["rule_id"] == "r1-pii-id-card"
        assert a3["action"] == "block"
        assert a3["payload"] == {"id_card": "110101199003071234"}
        assert a3["reason"] and "110101199003071234" in a3["reason"]

        # 审计 span 关联与 span 表一致（三行均含 trace/span 关联）
        for a in items:
            span = spans_by_id[a["span_id"]]
            assert span["name"] == f"execute_tool {a['tool_name']}"

    def test_event_log_count_is_two_times_spans(self, run, spans_by_id):
        deps = run["deps"]
        events = deps.storage.replay_events(after_id=0)
        # 机验7：event_log 条数 = span 数 ×2（每 span 恰一条 span.start + 一条 span.end）
        assert len(events) == SPAN_COUNT_PER_RUN * 2
        starts = [e for e in events if e["kind"] == "span.start"]
        ends = [e for e in events if e["kind"] == "span.end"]
        assert len(starts) == SPAN_COUNT_PER_RUN
        assert len(ends) == SPAN_COUNT_PER_RUN
        # span.end 整行快照携带补时长后的 end（#12 验收：UPDATE 后、广播前）
        ended_ids = {json.loads(e["payload"])["span_id"] for e in ends}
        assert ended_ids == set(spans_by_id)
        for e in ends:
            snap = json.loads(e["payload"])
            assert snap["end_time_unix_nano"] is not None
            assert snap["end_time_unix_nano"] >= snap["start_time_unix_nano"]


# ---------------------------------------------------------------- 机验8（#10 条目8）：查询 API

class TestQueryApis:
    """机验8：GET /api/traces blocked=true；详情平铺数组可建树；audits?verdict=block 恰一行。"""

    def test_traces_list_blocked_true(
        self, run  # 机验8：GET /api/traces 该 trace blocked=true（#13 修复路径回归）
    ):
        deps = run["deps"]
        client = TestClient(create_app(deps.storage, deps.engine, deps.hub))
        resp = client.get("/api/traces", params={"agent_id": "customer-service"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["total"] == 1
        item = body["items"][0]
        assert item["trace_id"] == run["trace_id"]
        assert item["blocked"] is True
        assert item["span_count"] == SPAN_COUNT_PER_RUN

    def test_trace_detail_flat_array_builds_tree(
        self, run  # 机验8：GET /api/traces/{id} 平铺数组按 parent_span_id 可建树
    ):
        deps = run["deps"]
        client = TestClient(create_app(deps.storage, deps.engine, deps.hub))
        resp = client.get(f"/api/traces/{run['trace_id']}")
        assert resp.status_code == 200
        spans = resp.json()["spans"]
        # 平铺数组按 start 升序（契约 §2.2）
        starts = [s["start_time_unix_nano"] for s in spans]
        assert starts == sorted(starts)
        # 消费端可建树：恰一根、无孤儿（每个非根 span 的 parent 都在集合内）
        ids = {s["span_id"] for s in spans}
        roots = [s for s in spans if s["parent_span_id"] is None]
        assert len(roots) == 1
        for s in spans:
            if s["parent_span_id"] is not None:
                assert s["parent_span_id"] in ids

    def test_audits_verdict_block_exactly_one(
        self, run  # 机验8：GET /api/audits?verdict=block 恰一行
    ):
        deps = run["deps"]
        client = TestClient(create_app(deps.storage, deps.engine, deps.hub))
        resp = client.get("/api/audits", params={"verdict": "block"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["total"] == 1
        item = body["items"][0]
        assert item["verdict"] == "block"
        assert item["rule_id"] == "r1-pii-id-card"
        assert item["trace_id"] == run["trace_id"]


# ---------------------------------------------------------------- 机验9（#10 条目9）：行为断言

class TestBehavior:
    """机验9：block 时 fn 未执行（计数）；PolicyBlocked 携带 matched_rule/trace_id/span_id。"""

    def test_blocked_fn_not_executed(
        self, run  # 机验9：block 时 fn 未执行（计数断言）
    ):
        deps = run["deps"]
        calls: list[str] = []

        # 直调 SDK 派发入口：r1 命中即 block，fn 计数保持 0（被拦七步，#8）
        def probe_fn():
            calls.append("verify_customer_id")
            return {"verified": True}

        with deps.sdk.agent_run("customer-service"):
            with pytest.raises(PolicyBlocked) as e1:
                deps.sdk.execute_tool(
                    "verify_customer_id",
                    {"id_card": "110101199003071234"},
                    probe_fn,
                )
        assert calls == []  # 机验9：block 时 fn 未执行

        pb = e1.value
        assert pb.matched_rule == "r1-pii-id-card"
        assert pb.trace_id and len(pb.trace_id) == 32
        assert pb.span_id and len(pb.span_id) == 16
        # span_id 与落库 span 一致（trace/span 关联）
        assert pb.span_id in {s["span_id"] for s in
                              deps.storage.get_trace_spans(pb.trace_id)}

    def test_allow_fn_executed_exactly_once(self, run):
        # 阴性对照（#12 TDD 同款）：未命中 allow 时 fn 执行且恰一次
        deps = run["deps"]
        calls: list[str] = []

        def probe_fn():
            calls.append("query_user_db")
            return {"found": True}

        with deps.sdk.agent_run("customer-service"):
            result = deps.sdk.execute_tool(
                "query_user_db", {"order_id": "20241025001"}, probe_fn
            )
        assert calls == ["query_user_db"]
        assert result == {"found": True}

    def test_policy_blocked_carries_identifiers(self, run):
        # 机验9：PolicyBlocked 携带 matched_rule / trace_id / span_id（独立断言便于逐条勾表）
        deps = run["deps"]
        with deps.sdk.agent_run("customer-service") as root:
            with pytest.raises(PolicyBlocked) as exc_info:
                deps.sdk.execute_tool(
                    "verify_customer_id",
                    {"id_card": "110101199003071234"},
                    lambda: (_ for _ in ()).throw(AssertionError("fn 不应执行")),
                )
        pb = exc_info.value
        assert pb.matched_rule == "r1-pii-id-card"
        assert pb.trace_id == root.trace_id
        assert isinstance(pb.span_id, str) and len(pb.span_id) == 16
