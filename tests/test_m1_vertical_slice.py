"""M1 垂直切片冒烟机验（issue #14；断言逐条对应 #10 决议机验 6–9，不自造）。

- 不走 demo.py 交互循环：进程内独立装配（tmp SQLite + 种子 4 条 + 引擎启动加载），
  ``TestClient`` 打 ASGI app，直接调用可导入的场景入口
  :func:`scenario.customer_service.agent.run_customer_service_turn`。
- #29 起使用受控 scripted LLM；旧正式 replay 的指纹保留，状态仍 BLOCKED。
- 覆盖 #12/#13 修过的三条缺陷位（回归保护，经变异抽查验证有效）：
  ① 观察期 span 标记（f440b24①）→ ``test_observation_span_attributes``；
  ② audit payload 8KB 字节截断（f440b24②）→ ``test_audit_payload_truncated_over_cap``；
  ③ 含点键的 ``blocked`` json_extract 引号路径（7999fbf）→ ``test_traces_list_blocked_true``。
- 只覆盖本票验收，不为地图 fog「测试策略与 CI」定全局（#10 原文）。
"""

from __future__ import annotations

import ast
import hashlib
import json
import re
import socket
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from scenario.customer_service.agent import run_customer_service_turn
from scenario.customer_service import config, tools as customer_tools
from scenario.customer_service.config import DEMO_USER_MESSAGE
from scenario.customer_service.scripted_llm import ScriptedLlmClient
from skill_observability.app import create_app
from skill_observability.db import Storage
from skill_observability.engine import PolicyEngine
from skill_observability.sdk import ObservabilitySdk, PolicyBlocked
from skill_observability.sse import EventHub

BASE_DIR = Path(__file__).resolve().parent.parent
SEED_PATH = BASE_DIR / "seed" / "rules.json"

# 场景三拍的三个工具调用（树三层 ×3 → 7 span）
SPAN_COUNT_PER_RUN = 7

ISSUE29_TOOL_NAMES = [
    "query_user_db",
    "query_contact_by_phone",
    "verify_customer_id",
    "create_callback_request",
    "get_delivery_eta",
]


@pytest.fixture()
def no_network(monkeypatch):
    """保护同步工具/agent 测试；不包住 Windows ASGI 事件循环的内部 socketpair。"""
    import httpx
    import openai

    attempts = []

    def forbidden(*args, **kwargs):
        attempts.append("external_io")
        raise AssertionError("external I/O is forbidden in issue 29 tests")

    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(socket.socket, "connect_ex", forbidden)
    monkeypatch.setattr(socket, "create_connection", forbidden)
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", forbidden)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", forbidden)
    monkeypatch.setattr(openai, "OpenAI", forbidden)
    monkeypatch.setattr(openai, "AsyncOpenAI", forbidden)
    yield
    assert len(attempts) == 0


def _fixture_profile() -> dict:
    """PII 仅从既有 fixture 在测试内存中读取。"""
    phone = config.ORDERS["20241025001"]["customer_phone"]
    return config.USER_PROFILES[phone]


# ---------------------------------------------------------------- 装配（demo bootstrap 同构，进程隔离）

class _Deps:
    """测试进程内装配：tmp 库、种子播种、引擎启动加载——与 demo.py DemoDeps 同构。"""

    def __init__(self, tmp_path: Path):
        self.storage = Storage(tmp_path / "aop_test_29.sqlite")
        seed = json.loads(SEED_PATH.read_text(encoding="utf-8"))
        self.storage.seed_rules_if_empty(seed, time.time_ns())
        self.engine = PolicyEngine()
        self.engine.reload(self.storage.load_rule_rows(), self.storage.get_rules_version())
        self.hub = EventHub()
        self.sdk = ObservabilitySdk(self.storage, self.engine, self.hub)
        self.llm = ScriptedLlmClient()


@pytest.fixture()
def deps(tmp_path) -> _Deps:
    return _Deps(tmp_path)


@pytest.fixture()
def run(deps) -> dict:
    """跑一遍三拍全程（allow → 观察期 → block → 终止报告），返回结果字段。"""
    run_start = time.time_ns()
    result = run_customer_service_turn(deps.sdk, deps.llm, DEMO_USER_MESSAGE)
    return {"trace_id": result.trace_id, "run_start": run_start}


@pytest.fixture()
def client(deps):
    return TestClient(create_app(deps.storage, deps.engine, deps.hub))


@pytest.fixture()
def spans_by_id(client, run) -> dict:
    """本 trace 全部 span，按 span_id 索引（经查询 API 拉回，端到端真实）。"""
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
        # 回归①（#12 评审缺陷 f440b24）：观察期命中必须落 verdict/matched_rule 两键
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

    def test_audit_three_rows(self, run, client, spans_by_id):
        # 机验7：audit 表三行语义正确——走查询 API 层（policy §3.2：payload 为
        # 已解析 JSON 对象，round-trip 端到端）；from 过滤与 printing.py 同款
        resp = client.get("/api/audits", params={"from": run["run_start"], "page_size": 100})
        assert resp.status_code == 200
        body = resp.json()
        assert body["total"] == 3  # 机验7：三行语义——本 run 恰三行
        items = body["items"]
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
        phone_matches = a2["payload"] == {"phone": _fixture_profile()["phone"]}
        assert phone_matches, "fixture phone derivation mismatch"
        assert a2["trace_id"] == run["trace_id"]

        # ③ 身份证 block + r1（#10 人验4③）
        a3 = by_tool["verify_customer_id"]
        assert a3["verdict"] == "block"
        assert a3["rule_id"] == "r1-pii-id-card"
        assert a3["action"] == "block"
        identity_matches = a3["payload"] == {"id_card": _fixture_profile()["id_card"]}
        assert identity_matches, "fixture identity derivation mismatch"
        reason_matches = bool(a3["reason"]) and _fixture_profile()["id_card"] in a3["reason"]
        assert reason_matches, "stored rule reason mismatch"

        # 审计 span 关联与 span 表一致（三行均含 trace/span 关联）
        for a in items:
            span = spans_by_id[a["span_id"]]
            assert span["name"] == f"execute_tool {a['tool_name']}"

    def test_audit_payload_truncated_over_cap(self, deps, client):
        # 回归②（#12 评审缺陷 f440b24）：payload 超 8KB **字节**上限——截断保持可解析、
        # payload_truncated 与「内容是否真被切」严格同步（policy §3.1）。旧缺陷下
        # 读侧 json.loads 抛错、GET /api/audits 500。
        huge = {"note": "汉" * 9000}  # UTF-8 每字 3B ≈ 27KB，超 8192B
        assert len(json.dumps(huge, ensure_ascii=False).encode("utf-8")) > 8 * 1024
        with deps.sdk.agent_run("customer-service"):
            deps.sdk.execute_tool("query_user_db", huge, lambda: {"found": False})
            # 阴性对照：同 run 一个未超限调用，标志应保持 0
            deps.sdk.execute_tool(
                "query_user_db", {"order_id": "20241025001"}, lambda: {"found": True}
            )

        resp = client.get("/api/audits", params={"page_size": 100})
        assert resp.status_code == 200  # 读侧 round-trip 不抛错（缺陷位回归）
        items = resp.json()["items"]
        assert len(items) == 2

        truncated = [a for a in items if a["payload_truncated"]]
        assert len(truncated) == 1  # 恰超限那行置 1
        row = truncated[0]
        # 截断语义：保留原内容前缀（#12 修复的字节预算落刀）
        assert huge["note"].startswith(row["payload"]["note"])
        assert row["payload"]["note"] != huge["note"]
        stored_bytes = len(json.dumps(row["payload"], ensure_ascii=False).encode("utf-8"))
        assert stored_bytes <= 8 * 1024  # 契约 policy §3.1：8KB 字节上限

        small = [a for a in items if not a["payload_truncated"]]
        assert len(small) == 1
        assert small[0]["payload"] == {"order_id": "20241025001"}  # 未超限原样

    def test_event_log_count_is_two_times_spans(self, deps, spans_by_id):
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
        self, run, client  # 机验8：GET /api/traces 该 trace blocked=true
    ):
        # 回归③（#13 bug 7999fbf）：含点键 json_extract 必须引号路径，裸路径恒 NULL
        resp = client.get("/api/traces", params={"agent_id": "customer-service"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["total"] == 1
        item = body["items"][0]
        assert item["trace_id"] == run["trace_id"]
        assert item["blocked"] is True
        assert item["span_count"] == SPAN_COUNT_PER_RUN

    def test_trace_detail_flat_array_builds_tree(
        self, run, client  # 机验8：GET /api/traces/{id} 平铺数组按 parent_span_id 可建树
    ):
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
        self, run, client  # 机验8：GET /api/audits?verdict=block 恰一行
    ):
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
        self, deps  # 机验9：block 时 fn 未执行（计数断言）
    ):
        calls: list[str] = []

        # 直调 SDK 派发入口：r1 命中即 block，fn 计数保持 0（被拦七步，#8）
        def probe_fn():
            calls.append("verify_customer_id")
            return {"verified": True}

        with deps.sdk.agent_run("customer-service"):
            with pytest.raises(PolicyBlocked) as exc_info:
                deps.sdk.execute_tool(
                    "verify_customer_id",
                    {"id_card": _fixture_profile()["id_card"]},
                    probe_fn,
                )
        assert calls == []  # 机验9：block 时 fn 未执行

        pb = exc_info.value
        assert pb.matched_rule == "r1-pii-id-card"
        assert pb.trace_id and len(pb.trace_id) == 32
        assert pb.span_id and len(pb.span_id) == 16
        # span_id 与落库 span 一致（trace/span 关联）
        assert pb.span_id in {s["span_id"] for s in
                              deps.storage.get_trace_spans(pb.trace_id)}

    def test_allow_fn_executed_exactly_once(self, deps):
        # 阴性对照（#12 TDD 同款）：未命中 allow 时 fn 执行且恰一次
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

    def test_policy_blocked_carries_identifiers(self, deps):
        # 机验9：PolicyBlocked 携带 matched_rule / trace_id / span_id（独立断言便于逐条勾表）
        def must_not_run():
            raise AssertionError("fn 不应执行")

        with deps.sdk.agent_run("customer-service") as root:
            with pytest.raises(PolicyBlocked) as exc_info:
                deps.sdk.execute_tool(
                    "verify_customer_id",
                    {"id_card": _fixture_profile()["id_card"]},
                    must_not_run,
                )
        pb = exc_info.value
        assert pb.matched_rule == "r1-pii-id-card"
        assert pb.trace_id == root.trace_id
        assert isinstance(pb.span_id, str) and len(pb.span_id) == 16


# ---------------------------------------------------------------- M2-02（#17）：静态托管冒烟

class TestDashboardStaticHosting:
    """M2-02（#17）新增静态托管断言：壳页 index.html 托管在场 + /api/* 不受 StaticFiles 影响。

    测试装配沿用 create_app（纯净、无 StaticFiles）——静态挂载在 demo 装配层，
    本类复用 demo.mount_dashboard（与 demo.py 完全同一挂载逻辑与参数）验证托管行为。
    """

    def _mount_dashboard(self, client):
        from demo import dashboard_state, mount_dashboard

        if dashboard_state() != "ready":  # dist 缺失属环境问题（未跑 npm run build），跳过并明示
            pytest.skip("dashboard/dist 不存在：先 cd dashboard && npm run build")
        mount_dashboard(client.app)

    def test_dashboard_index_served_with_shell_mount_point(self, client):
        # GET / 返回 index.html，含壳页挂载点 <div id="root">
        self._mount_dashboard(client)
        resp = client.get("/")
        assert resp.status_code == 200
        assert "text/html" in resp.headers["content-type"]
        assert '<div id="root">' in resp.text  # 壳页挂载点在场
        # 断网兜底（M7）：产物无在线字体/CDN 引用
        assert "fonts.googleapis" not in resp.text
        assert "https://cdn" not in resp.text

    def test_api_routes_unaffected_by_static_mount(self, client, run):
        # demo 同款挂载后，/api/* 仍走 API 路由（不被静态文件吞掉）
        self._mount_dashboard(client)
        resp = client.get("/api/traces", params={"page_size": 1})
        assert resp.status_code == 200
        assert resp.json()["total"] >= 1  # 已有 run 在场（fixture 链），API 行为不变
        # 返回体是 JSON 而非 index.html 兜底（StaticFiles html=True 的 404 fallback 不吞 API）
        assert "text/html" not in resp.headers["content-type"]

    def test_dashboard_dist_missing_serves_build_guide(self, deps, monkeypatch):
        # dist 缺失时根路径返回构建指引页（非 404 白屏），API 不受影响
        import demo as demo_mod

        monkeypatch.setattr(
            demo_mod, "DASHBOARD_DIST", BASE_DIR / "dashboard" / "dist-nonexistent"
        )
        # make_asgi_app 只用 storage/engine/hub 三个依赖——借测试装配构造最小实例
        minimal = demo_mod.DemoDeps.__new__(demo_mod.DemoDeps)
        minimal.storage = deps.storage
        minimal.engine = deps.engine
        minimal.hub = deps.hub
        client = TestClient(minimal.make_asgi_app())

        resp = client.get("/")
        assert resp.status_code == 200
        assert "text/html" in resp.headers["content-type"]
        assert "npm run build" in resp.text  # 指引页含构建命令
        resp_api = client.get("/api/traces", params={"page_size": 1})
        assert resp_api.status_code == 200  # API 不受缺失影响


# ---------------------------------------------------------------- M2-07（#22）：audits?action= 三态


class TestAuditActionFilter:
    """M2-07：`action` 参数三态（契约 policy §3.2「新增过滤参数」表首行）。

    - `action=audit` ≙ `verdict='allow' AND action='audit'`（观察期命中，卡 5 同源）；
    - `action=block` 行均 `verdict='block'`；
    - `rule_id IS NULL` 的未命中行（action 为 NULL）不匹配任何 action 值。
    """

    def test_action_audit_is_observation_hits(self, run, client):
        resp = client.get("/api/audits", params={"action": "audit"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["total"] == 1  # 本 run 恰一行观察期命中（手机号 r1b）
        item = body["items"][0]
        assert item["verdict"] == "allow"
        assert item["action"] == "audit"
        assert item["rule_id"] == "r1b-pii-phone-audit"
        assert item["trace_id"] == run["trace_id"]

    def test_action_block_rows_all_blocked(self, run, client):
        resp = client.get("/api/audits", params={"action": "block"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["total"] == 1  # 本 run 恰一行拦截（身份证 r1）
        assert all(a["verdict"] == "block" and a["action"] == "block" for a in body["items"])
        assert body["items"][0]["rule_id"] == "r1-pii-id-card"

    def test_action_filter_never_returns_miss_rows(self, run, client):
        # 未命中行 action 为 NULL：两个 action 值都不该带出它（三行中永远排除的那一行）
        all_rows = client.get("/api/audits", params={"page_size": 100}).json()["items"]
        miss = [a for a in all_rows if a["rule_id"] is None]
        assert len(miss) == 1 and miss[0]["action"] is None

        for action in ("audit", "block"):
            rows = client.get("/api/audits", params={"action": action, "page_size": 100}).json()["items"]
            assert miss[0]["id"] not in {a["id"] for a in rows}

    def test_action_and_verdict_combine_and_invalid_values_422(self, run, client):
        # 组合是 AND：audit + allow 仍命中观察期那行；audit + block 为空集
        both = client.get("/api/audits", params={"action": "audit", "verdict": "allow"})
        assert both.status_code == 200 and both.json()["total"] == 1
        empty = client.get("/api/audits", params={"action": "audit", "verdict": "block"})
        assert empty.status_code == 200 and empty.json()["total"] == 0
        # 非法值 422（pattern 校验与 verdict 同款）
        for bad in ({"action": "observe"}, {"action": ""}, {"action": "BLOCK"}):
            assert client.get("/api/audits", params=bad).status_code == 422

    def test_action_audit_follows_contract_and_semantics(self, client, deps):
        # 契约原文：action=audit ≙ verdict='allow' AND action='audit'——两个条件缺一不可。
        # SDK 正常路径下 action='audit' 的行恒为 verdict='allow'（audit 动作不拦截），
        # 所以这条 AND 子句只有面对非正常写入才可鉴别：直接落一行自相矛盾的
        # verdict=block + action=audit（DDL 只做单列 CHECK，不禁止组合），
        # 非法组合不得被 action=audit 带出（它是 block 行，归 action=block 也不对，
        # 但契约钉死的是 allow 语义）。
        defect_id = deps.storage.insert_audit(
            trace_id="a" * 32, span_id="b" * 16, agent_id="customer-service",
            tool_name="verify_customer_id", verdict="block", rule_id="r-road",
            rule_name="异常快照", action="audit", reason="非正常写入",
            payload_json="{}", payload_truncated=False, created_at_unix_nano=time.time_ns(),
        )
        rows = client.get("/api/audits", params={"action": "audit", "page_size": 100}).json()["items"]
        assert all(a["verdict"] == "allow" and a["action"] == "audit" for a in rows)
        assert defect_id not in {a["id"] for a in rows}

    def test_action_filter_pagination_total_matches(self, client, deps):
        # 造 3 行 audit + 2 行 block + 2 行未命中，验证 total 与翻页都按过滤后集合算
        with deps.sdk.agent_run("customer-service"):
            for i in range(3):
                deps.sdk.execute_tool("query_contact_by_phone", {"phone": f"1380000000{i}"}, lambda: {})
            for i in range(2):
                with pytest.raises(PolicyBlocked):
                    deps.sdk.execute_tool("verify_customer_id", {"id_card": f"11010119900307123{i}"}, lambda: {})
            for i in range(2):
                deps.sdk.execute_tool("query_user_db", {"order_id": f"2024{i}"}, lambda: {})

        audit_total = client.get("/api/audits", params={"action": "audit", "page_size": 1}).json()["total"]
        assert audit_total == 3
        page2 = client.get("/api/audits", params={"action": "audit", "page_size": 2, "page": 2}).json()
        assert len(page2["items"]) == 1 and page2["total"] == 3  # total 是过滤后总数，不是全表
        assert all(a["action"] == "audit" and a["verdict"] == "allow" for a in page2["items"])


# ---------------------------------------------------------------- M2-08（#23）：audits?trace_id= 精确定位


class TestAuditTraceFilter:
    """M2-08：trace_id 精确过滤，并与既有过滤和分页语义按 AND 组合。"""

    @staticmethod
    def _insert_other_trace_audit(deps):
        deps.storage.insert_audit(
            trace_id="c" * 32,
            span_id="d" * 16,
            agent_id="customer-service",
            tool_name="query_contact_by_phone",
            verdict="allow",
            rule_id="r1b-pii-phone-audit",
            rule_name="客户手机号外泄（观察期）",
            action="audit",
            reason="对照 trace",
            payload_json='{"phone":"13800000000"}',
            payload_truncated=False,
            created_at_unix_nano=time.time_ns(),
        )

    def test_trace_id_returns_the_three_rows_from_the_m1_run(self, run, client, deps):
        self._insert_other_trace_audit(deps)
        resp = client.get("/api/audits", params={"trace_id": run["trace_id"], "page_size": 100})
        assert resp.status_code == 200
        body = resp.json()
        assert body["total"] == 3
        assert len(body["items"]) == 3
        assert all(item["trace_id"] == run["trace_id"] for item in body["items"])

    def test_trace_id_combines_with_action_verdict_and_preserves_pagination(self, run, client, deps):
        self._insert_other_trace_audit(deps)
        observed = client.get(
            "/api/audits",
            params={"trace_id": run["trace_id"], "action": "audit", "verdict": "allow"},
        )
        assert observed.status_code == 200
        assert observed.json()["total"] == 1
        assert observed.json()["items"][0]["action"] == "audit"

        blocked = client.get(
            "/api/audits",
            params={"trace_id": run["trace_id"], "action": "block", "page": 1, "page_size": 1},
        )
        body = blocked.json()
        assert blocked.status_code == 200
        assert body["page"] == 1 and body["page_size"] == 1 and body["total"] == 1
        assert len(body["items"]) == 1
        assert body["items"][0]["verdict"] == "block"

    def test_unknown_trace_id_returns_empty_page(self, client, deps):
        self._insert_other_trace_audit(deps)
        resp = client.get("/api/audits", params={"trace_id": "f" * 32})
        assert resp.status_code == 200
        assert resp.json() == {"items": [], "page": 1, "page_size": 20, "total": 0}


def _insert_stat_audit(
    deps,
    index: int,
    *,
    rule_id: str | None,
    rule_name: str | None,
    action: str | None,
    verdict: str,
    agent_id: str = "agent-a",
) -> None:
    deps.storage.insert_audit(
        trace_id=f"{index:032x}",
        span_id=f"{index:016x}",
        agent_id=agent_id,
        tool_name="stat_tool",
        verdict=verdict,
        rule_id=rule_id,
        rule_name=rule_name,
        action=action,
        reason="stats regression",
        payload_json="{}",
        payload_truncated=False,
        created_at_unix_nano=time.time_ns(),
    )


class TestM211TraceLive:
    def test_live_filters_root_before_paging_and_preserves_default_behavior(self, deps, client):
        ended_trace = "1" * 32
        ended_root = "1" * 16
        deps.storage.start_span(
            ended_trace, ended_root, None, "ended root", "SERVER", 200, {}, "agent-a"
        )
        deps.storage.end_span(ended_root, 201, "OK", None, {}, [])
        deps.storage.start_span(
            ended_trace, "2" * 16, ended_root, "ended child", "INTERNAL", 201, {}, "agent-a"
        )

        live_trace = "3" * 32
        live_root = "3" * 16
        deps.storage.start_span(
            live_trace, live_root, None, "live root", "SERVER", 100, {}, "agent-a"
        )

        default_response = client.get("/api/traces", params={"page_size": 1})
        false_response = client.get("/api/traces", params={"live": "false", "page_size": 1})
        live_response = client.get("/api/traces", params={"live": "true", "page_size": 1})

        assert default_response.status_code == 200
        assert false_response.status_code == 200
        assert live_response.status_code == 200
        assert false_response.json() == default_response.json()
        assert default_response.json()["total"] == 2
        assert default_response.json()["items"][0]["trace_id"] == ended_trace
        assert live_response.json()["total"] == 1
        assert [item["trace_id"] for item in live_response.json()["items"]] == [live_trace]
        assert live_response.json()["items"][0]["span_count"] == 1

        deps.storage.end_span(live_root, 300, "OK", None, {}, [])
        assert client.get("/api/traces", params={"live": "true"}).json()["total"] == 0

    def test_live_composes_with_agent_and_root_time_filters(self, deps, client):
        selected_trace = "4" * 32
        other_trace = "5" * 32
        deps.storage.start_span(
            selected_trace, "4" * 16, None, "selected", "SERVER", 300, {}, "agent-a"
        )
        deps.storage.start_span(
            other_trace, "5" * 16, None, "other", "SERVER", 400, {}, "agent-b"
        )

        response = client.get(
            "/api/traces",
            params={"live": "true", "agent_id": "agent-a", "from": 250, "to": 350},
        )
        assert response.status_code == 200
        assert response.json()["total"] == 1
        assert response.json()["items"][0]["trace_id"] == selected_trace


class TestM211AuditStatsByRule:
    @staticmethod
    def _insert_fixture_audits(deps):
        _insert_stat_audit(
            deps, 1, rule_id="rule-a", rule_name="Rule A", action="block", verdict="block"
        )
        _insert_stat_audit(
            deps, 2, rule_id="rule-a", rule_name="Rule A", action="block", verdict="allow"
        )
        _insert_stat_audit(
            deps, 3, rule_id="rule-a", rule_name="Rule A", action="block", verdict="allow"
        )
        _insert_stat_audit(
            deps, 4, rule_id="rule-b", rule_name="Rule B", action="audit", verdict="allow"
        )
        _insert_stat_audit(
            deps, 5, rule_id="rule-b", rule_name="Rule B", action="audit", verdict="allow"
        )
        _insert_stat_audit(
            deps, 6, rule_id="rule-b", rule_name="Rule B", action="audit", verdict="block"
        )
        for index, rule_id in enumerate(("rule-c", "rule-d", "rule-e"), start=7):
            _insert_stat_audit(
                deps,
                index,
                rule_id=rule_id,
                rule_name=rule_id.title(),
                action="block",
                verdict="block",
            )
        _insert_stat_audit(
            deps,
            10,
            rule_id="rule-f",
            rule_name="Rule F",
            action="block",
            verdict="block",
            agent_id="agent-b",
        )
        _insert_stat_audit(
            deps,
            11,
            rule_id=None,
            rule_name=None,
            action=None,
            verdict="allow",
        )

    def test_default_limit_and_stable_tie_order(self, deps, client):
        self._insert_fixture_audits(deps)

        default_body = client.get("/api/audits/stats/by-rule").json()
        limit_one = client.get("/api/audits/stats/by-rule", params={"limit": 1}).json()
        limit_fifty = client.get("/api/audits/stats/by-rule", params={"limit": 50}).json()

        assert default_body["total"] == 6
        assert [item["rule_id"] for item in default_body["items"]] == [
            "rule-a", "rule-b", "rule-c", "rule-d", "rule-e"
        ]
        assert [item["hits"] for item in default_body["items"]] == [3, 3, 1, 1, 1]
        assert limit_one["items"] == [default_body["items"][0]]
        assert limit_fifty["total"] == 6
        assert [item["rule_id"] for item in limit_fifty["items"]] == [
            "rule-a", "rule-b", "rule-c", "rule-d", "rule-e", "rule-f"
        ]

    def test_verdict_agent_filters_and_snapshot_counts(self, deps, client):
        self._insert_fixture_audits(deps)

        block_body = client.get(
            "/api/audits/stats/by-rule", params={"verdict": "block"}
        ).json()
        allow_body = client.get(
            "/api/audits/stats/by-rule", params={"verdict": "allow", "agent_id": "agent-a"}
        ).json()
        agent_body = client.get(
            "/api/audits/stats/by-rule", params={"agent_id": "agent-b"}
        ).json()

        assert block_body["total"] == 6
        assert all(item["hits"] == 1 for item in block_body["items"])
        assert allow_body["total"] == 2
        assert [(item["rule_id"], item["hits"]) for item in allow_body["items"]] == [
            ("rule-a", 2), ("rule-b", 2)
        ]
        assert agent_body["total"] == 1
        assert agent_body["items"][0]["rule_id"] == "rule-f"
        assert agent_body["items"][0]["verdict_block_hits"] == 1
        assert agent_body["items"][0]["verdict_audit_hits"] == 0

    def test_invalid_limit_and_verdict_return_422(self, client):
        for params in (
            {"limit": 0},
            {"limit": 51},
            {"verdict": "deny"},
        ):
            assert client.get("/api/audits/stats/by-rule", params=params).status_code == 422

    def test_deleted_rule_keeps_audit_snapshot_and_ignores_null_rule(self, deps, client):
        _insert_stat_audit(
            deps,
            20,
            rule_id="r1-pii-id-card",
            rule_name="历史快照规则",
            action="block",
            verdict="block",
        )
        _insert_stat_audit(
            deps,
            21,
            rule_id=None,
            rule_name=None,
            action=None,
            verdict="allow",
        )

        delete_response = client.delete("/api/rules/r1-pii-id-card")
        stats_response = client.get("/api/audits/stats/by-rule", params={"limit": 50})

        assert delete_response.status_code == 204
        assert stats_response.status_code == 200
        body = stats_response.json()
        assert body["total"] == 1
        assert body["items"] == [{
            "rule_id": "r1-pii-id-card",
            "rule_name": "历史快照规则",
            "action": "block",
            "verdict_block_hits": 1,
            "verdict_audit_hits": 0,
            "hits": 1,
        }]


class TestIssue29:
    def test_five_tool_schemas_and_registry(self):
        fields = ["order_id", "phone", "id_card", "order_id", "order_id"]
        descriptions = [
            ("查询订单数据库，返回订单的物流状态等最新信息", "订单号，如 20241025001"),
            ("按手机号查询客户联系资料，用于回电前核对客户信息", "客户手机号，展示时如 138****5678"),
            ("按身份证号查询客户实名核验信息，用于回拨前身份核对", "客户 18 位身份证号"),
            ("在合成本地场景创建派送前回电请求", "需要派送前回电的订单号"),
            ("从合成订单查询配送预计时间", "查询配送预计时间的订单号"),
        ]
        expected = [
            {
                "type": "function",
                "function": {
                    "name": name,
                    "description": description,
                    "parameters": {
                        "type": "object",
                        "properties": {field: {"type": "string", "description": field_description}},
                        "required": [field],
                    },
                },
            }
            for name, field, (description, field_description) in zip(
                ISSUE29_TOOL_NAMES, fields, descriptions
            )
        ]
        assert config.TOOLS == expected
        assert list(customer_tools.TOOL_IMPLS) == ISSUE29_TOOL_NAMES
        for name in ISSUE29_TOOL_NAMES:
            assert customer_tools.TOOL_IMPLS[name] is getattr(customer_tools, name)

    def test_fixed_user_message_and_system_prompt(self):
        assert DEMO_USER_MESSAGE == (
            "帮我查一下订单 20241025001 的物流进度，并安排派送前回电。"
            "回电前请完成客户身份核验，再告诉我处理结果。"
        )
        assert re.search(r"1[3-9]\d{9}|\d{17}[\dXx]", DEMO_USER_MESSAGE) is None
        assert config.SYSTEM_PROMPT == (
            "你是电商客服助手。根据订单号查询物流与联系线索，再用工具返回的手机号查询回电核验资料，"
            "使用资料中的身份证号尝试实名核验。不要编造资料或要求用户直接提供这些号码。"
            "任何工具调用被隐私合规策略拦截后，立即停止本次任务，不重试、不换工具绕过，"
            "也不继续创建回电请求。向客户说明策略拦截、任务已停止并转人工，"
            "不展示原始手机号或身份证号。所有可见号码必须掩码。"
        )

    def test_order_and_contact_derive_fixture_pii(self, no_network):
        order = customer_tools.query_user_db({"order_id": "20241025001"})
        assert order["found"] is True
        phone_matches = (
            order["order"]["customer_phone"] == config.ORDERS["20241025001"]["customer_phone"]
        )
        assert phone_matches, "order fixture contact mismatch"
        profile = customer_tools.query_contact_by_phone(
            {"phone": order["order"]["customer_phone"]}
        )
        assert profile["found"] is True
        identity_matches = profile["profile"]["id_card"] == _fixture_profile()["id_card"]
        assert identity_matches, "contact fixture identity mismatch"
        record_matches = (
            config.REALNAME_RECORDS[profile["profile"]["id_card"]]["id_card"]
            == _fixture_profile()["id_card"]
        )
        assert record_matches, "realname fixture relation mismatch"

    def test_callback_and_eta_local_results(self, no_network):
        assert customer_tools.create_callback_request({"order_id": "20241025001"}) == {
            "created": True,
            "request": {
                "request_id": "callback-20241025001",
                "order_id": "20241025001",
                "timing": "派送前",
                "status": "待回电",
            },
        }
        assert customer_tools.get_delivery_eta({"order_id": "20241025001"}) == {
            "found": True, "order_id": "20241025001",
            "eta": config.ORDERS["20241025001"]["eta"],
        }
        assert customer_tools.create_callback_request({"order_id": "missing"}) == {
            "created": False, "order_id": "missing", "message": "订单不存在",
        }
        assert customer_tools.get_delivery_eta({"order_id": "missing"}) == {
            "found": False, "order_id": "missing", "message": "订单不存在",
        }

    def test_scripted_three_step_contract(self, no_network):
        llm = ScriptedLlmClient()
        messages = [
            {"role": "system", "content": config.SYSTEM_PROMPT},
            {"role": "user", "content": DEMO_USER_MESSAGE},
        ]
        names = []
        for step, expected in enumerate(ISSUE29_TOOL_NAMES[:3]):
            response = llm.chat(messages, config.TOOLS)
            assert len(response.tool_calls) == 1
            call = response.tool_calls[0]
            names.append(call.name)
            assert call.name == expected
            assert call.call_id == f"scripted-{step + 1}"
            assert response.content is None and response.usage is None
            expected_args = [
                {"order_id": "20241025001"},
                {"phone": _fixture_profile()["phone"]},
                {"id_card": _fixture_profile()["id_card"]},
            ][step]
            args_match = call.args == expected_args
            assert args_match, "scripted argument derivation mismatch"
            # 只执行两个安全查询。第三步只验证契约，绝不进入实名函数体。
            result = customer_tools.TOOL_IMPLS[expected](call.args) if step < 2 else {}
            messages.append({
                "role": "tool", "tool_call_id": call.call_id,
                "content": json.dumps(result, ensure_ascii=False),
            })
        assert names == ["query_user_db", "query_contact_by_phone", "verify_customer_id"]
        for _ in range(2):
            terminal = llm.chat(messages, config.TOOLS)
            assert terminal.tool_calls == []
        # 本地实现只允许标准库的数据处理依赖，不导入旧网络客户端或环境模块。
        source = BASE_DIR / "scenario" / "customer_service" / "scripted_llm.py"
        imports = set()
        for node in ast.walk(ast.parse(source.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Import):
                imports.update(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                imports.add(node.module)
        assert imports <= {"__future__", "json", "dataclasses"}

    def test_agent_stops_at_r1_with_zero_bodies(self, deps, no_network, monkeypatch):
        body_counts = dict.fromkeys(ISSUE29_TOOL_NAMES, 0)
        attempted = []
        for name in ISSUE29_TOOL_NAMES:
            original = customer_tools.TOOL_IMPLS[name]

            def counted(args, _name=name, _original=original):
                body_counts[_name] += 1
                return _original(args)

            monkeypatch.setitem(customer_tools.TOOL_IMPLS, name, counted)

        execute_tool = deps.sdk.execute_tool

        def observed_execute(name, args, fn, **kwargs):
            attempted.append(name)
            return execute_tool(name, args, fn, **kwargs)

        monkeypatch.setattr(deps.sdk, "execute_tool", observed_execute)
        result = run_customer_service_turn(deps.sdk, deps.llm, DEMO_USER_MESSAGE)
        # 独立断言使两个可达 mutation 分别击中实名和回电计数。
        assert 0 == body_counts["verify_customer_id"]
        assert 0 == body_counts["create_callback_request"]
        assert 0 == body_counts["get_delivery_eta"]
        assert body_counts["query_user_db"] == 1
        assert body_counts["query_contact_by_phone"] == 1
        assert attempted == ISSUE29_TOOL_NAMES[:3]

        spans = deps.storage.get_trace_spans(result.trace_id)
        assert len(spans) == 7
        tool_spans = [s for s in spans if s["name"].startswith("execute_tool ")]
        assert [s["name"] for s in tool_spans] == [f"execute_tool {n}" for n in attempted]
        blocked = tool_spans[-1]
        assert blocked["status_code"] == "ERROR"
        assert blocked["attributes"]["error.type"] == "policy.block"
        assert blocked["attributes"]["skill_observability.matched_rule"] == "r1-pii-id-card"
        assert blocked["attributes"]["skill_observability.verdict"] == "block"
        root = next(s for s in spans if s["parent_span_id"] is None)
        assert root["status_code"] == "UNSET" and root["end_time_unix_nano"] is not None

        items, total = deps.storage.list_audits(
            verdict=None, agent_id=None, tool_name=None, rule_id=None,
            from_ns=None, to_ns=None, page=1, page_size=100,
            trace_id=result.trace_id,
        )
        assert total == 3
        rows = sorted(items, key=lambda row: row["id"])
        assert [r["tool_name"] for r in rows] == attempted
        assert [(r["verdict"], r["action"], r["rule_id"]) for r in rows] == [
            ("allow", None, None),
            ("allow", "audit", "r1b-pii-phone-audit"),
            ("block", "block", "r1-pii-id-card"),
        ]
        assert [r["span_id"] for r in rows] == [s["span_id"] for s in tool_spans]
        # answer 含旧运行时原理由，仅在内存作布尔检查，不输出原文。
        stopped = "[终止报告]" in result.answer and "不重试、不改道" in result.answer
        assert stopped, "agent did not report termination"

    @pytest.mark.parametrize("relative_path,size,digest", [
        (
            "scenario/cassettes/customer-service.yaml", 8256,
            "31780679f339ae5036087f785649df88a13eeebe6630bb3faa869a53d23c4cb4",
        ),
        (
            "scenario/customer_service/llm.py", 2974,
            "067150caf9f1a57917ac8293d0b5562930f34c302a30941c367e7f6b6e8976fb",
        ),
    ])
    def test_formal_replay_stays_blocked_with_unchanged_fingerprints(
        self, relative_path, size, digest,
    ):
        raw = (BASE_DIR / relative_path).read_bytes()
        assert len(raw) == size
        assert hashlib.sha256(raw).hexdigest() == digest
        assert config.FORMAL_REPLAY_STATUS == "BLOCKED"
