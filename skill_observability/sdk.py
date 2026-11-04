"""埋点 SDK：三原语 ``agent_run`` / ``chat`` / ``execute_tool``（#8 决议）。

- 分层 API：上下文管理器做原语（根 span ``agent_run``、LLM span ``chat``），
  Skill 调用走唯一派发入口 :meth:`ObservabilitySdk.execute_tool` ——拦截点不可绕过，
  「block 则 ``fn`` 绝不执行」在结构上成立（#8 决议 1）。
- 父子传递 = ``contextvars``：进入 span 设置、退出（含异常）恢复；``trace_id``
  根 span 生成后全程继承（#8 决议 2）。
- ``execute_tool`` 八步原子时序（#8），被拦时走七步（跳过 ⑤ 执行 ``fn``）：

  ① 生成 span_id，contextvar 取 parent，继承 trace_id
  ② span 落库（end=NULL）→ event_log(span.start) → 同进程推 SSE
  ③ 同步调 engine.evaluate(...)
  ④ 写审计记录（无论 verdict；payload 快照 + trace_id/span_id）
  ⑤ allow → 执行 fn()；block → 不执行
  ⑥ span UPDATE：成功 UNSET；fn 异常 → ERROR + exception 事件 + error.type=类名；
     block → ERROR + error.type="policy.block" + skill_observability.*
  ⑦ event_log(span.end) → 推 SSE
  ⑧ allow → 返回结果（fn 异常原样重抛）；block → 抛 PolicyBlocked

- 审计写入在 SDK 拦截点统一完成，引擎纯函数（#8 决议 5）。
- event_log 写入时机：span 落库 / UPDATE 之后、SSE 广播之前（trace 契约 §1.3）。
"""

from __future__ import annotations

import json
import secrets
import time
import traceback
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, Callable

from skill_observability.engine import EvalContext, PolicyEngine, Verdict
from skill_observability.sse import EventHub
from skill_observability.db import Storage

# 审计 payload 快照上限（policy §3.1：8KB，超出截断并置 payload_truncated=1）
_AUDIT_PAYLOAD_CAP_BYTES = 8 * 1024


class PolicyBlocked(Exception):
    """block 语义专用异常（#8 决议 3）：子任务边界捕获 → 报告 → 终止，不重试。"""

    def __init__(self, matched_rule: str, block_reason: str, trace_id: str, span_id: str):
        super().__init__(block_reason)
        self.matched_rule = matched_rule
        self.block_reason = block_reason
        self.trace_id = trace_id
        self.span_id = span_id


@dataclass(frozen=True)
class _SpanContext:
    """contextvar 里传递的当前 span 身份。"""

    trace_id: str
    span_id: str
    agent_id: str


_current_span: ContextVar[_SpanContext | None] = ContextVar(
    "skill_observability.current_span", default=None
)


class SpanHandle:
    """开放中的 span：允许调用方补属性（如 ``gen_ai.usage.*``）与事件。"""

    def __init__(self, trace_id: str, span_id: str, attributes: dict, events: list[dict]):
        self.trace_id = trace_id
        self.span_id = span_id
        self._attributes = attributes
        self._events = events

    def set_attribute(self, key: str, value: Any) -> None:
        self._attributes[key] = value


def _truncate_json_text(text: str, cap_bytes: int) -> str:
    """把序列化 JSON 截到 cap **字节**内并保持可解析（audit 契约 §3.1/§3.2）。

    按字节预算逐字符扫描（UTF-8 多字节安全），只在保证合法的位置落刀：

    - **值字符串内部**（``expect_value`` 为真时进入的字符串）：任意非转义点可切，
      补闭合引号即可（``{"note": "汉⎹`` → ``{"note": "汉"}``）；
    - **闭符 ``}``/``]`` 之后**（含闭符）或**逗号之前**（不含逗号）——值完成边界，
      补齐未闭合括号即合法；键字符串内部与冒号后**不可**切（``{"k"}`` / ``{"a":}`` 非法）；
    - 绝不切进 ``\\uXXXX`` 转义中间（``escaped`` / ``unicode_pending`` 守卫）；
    - cap 内不存在任何边界（如首个键字符串本身超长、巨型标量）时兜底 ``{}``。

    结果恒为合法 JSON 且字节数 ≤ cap（候选时已预留闭合符字节）。防御性上限，
    演示数据远小于此。
    """
    if len(text.encode("utf-8")) <= cap_bytes:
        return text
    stack: list[str] = []
    in_string = False
    string_is_value = False  # 进入当前字符串时是否处于值位置（键串不可切）
    escaped = False
    unicode_pending = 0      # \uXXXX 余下的 hex 位
    expect_value = False     # 下一个字符串是否为值（数组内恒为值）
    best: tuple[int, int, str] | None = None  # (结果字节数, 前缀字符长, 后缀)
    byte = 0

    for i, ch in enumerate(text):
        w = len(ch.encode("utf-8"))
        if byte + w > cap_bytes:
            break
        byte += w
        if in_string:
            if escaped:
                escaped = False
                if ch == "u":
                    unicode_pending = 4
                continue
            if unicode_pending:
                unicode_pending -= 1
                continue
            if ch == "\\":
                escaped = True
                continue
            if ch == '"':
                in_string = False
                if string_is_value:  # 值串闭合点是边界
                    closers = "".join(reversed(stack))
                    if byte + len(closers) <= cap_bytes:
                        best = (byte + len(closers), i + 1, closers)
                continue
            if string_is_value:  # 值串内任意非转义点：补引号+闭合
                closers = "".join(reversed(stack))
                if byte + 1 + len(closers) <= cap_bytes:
                    best = (byte + 1 + len(closers), i + 1, '"' + closers)
            continue

        if ch == '"':
            in_string = True
            string_is_value = expect_value
        elif ch == ":":
            expect_value = True
        elif ch == ",":
            closers = "".join(reversed(stack))
            if byte - 1 + len(closers) <= cap_bytes:
                best = (byte - 1 + len(closers), i, closers)
            expect_value = bool(stack) and stack[-1] == "]"
        elif ch in "{[":
            stack.append("}" if ch == "{" else "]")
            expect_value = ch == "["
        elif ch in "}]":
            if stack and stack[-1] == ch:
                stack.pop()
            closers = "".join(reversed(stack))
            if byte + len(closers) <= cap_bytes:
                best = (byte + len(closers), i + 1, closers)
            expect_value = bool(stack) and stack[-1] == "]"
        # 其余字符（标量/空白）：边界由随后的 , } ] 收割
    return text[: best[1]] + best[2] if best else "{}"


class ObservabilitySdk:
    """进程内 SDK：与 FastAPI 同进程，共用 storage / engine（#8 决议 4）。"""

    def __init__(
        self,
        storage: Storage,
        engine: PolicyEngine,
        hub: EventHub,
        *,
        clock: Callable[[], int] = time.time_ns,
    ):
        self._storage = storage
        self._engine = engine
        self._hub = hub
        self._clock = clock

    # ---------------------------------------------------------------- 原语 1：agent_run（根 span）

    @contextmanager
    def agent_run(self, agent_id: str):
        """根 span：``invoke_agent {agent_id}``，trace_id 在此生成、全程继承。"""
        trace_id = secrets.token_hex(16)  # 32 小写 hex（契约 §1.2）
        span_id = secrets.token_hex(8)    # 16 小写 hex
        attributes = {
            "gen_ai.operation.name": "invoke_agent",
            "service.name": agent_id,
        }
        with self._managed_span(
            trace_id=trace_id, parent_span_id=None, span_id=span_id,
            agent_id=agent_id, name=f"invoke_agent {agent_id}",
            kind="INTERNAL", attributes=attributes,
        ) as handle:
            yield handle

    # ---------------------------------------------------------------- 原语 2：chat（LLM CLIENT span）

    @contextmanager
    def chat(self, model: str):
        """LLM 调用 span：``chat {model}``，CLIENT；须嵌在 agent_run 内。"""
        parent = self._require_parent("chat()")
        span_id = secrets.token_hex(8)
        attributes = {
            "gen_ai.operation.name": "chat",
            "gen_ai.request.model": model,
            "gen_ai.provider.name": "openai",
            "service.name": parent.agent_id,
        }
        with self._managed_span(
            trace_id=parent.trace_id, parent_span_id=parent.span_id, span_id=span_id,
            agent_id=parent.agent_id, name=f"chat {model}",
            kind="CLIENT", attributes=attributes,
        ) as handle:
            yield handle

    # ---------------------------------------------------------------- 原语 3：execute_tool（唯一派发入口 + 拦截点）

    def execute_tool(
        self, name: str, args: dict, fn: Callable[[], Any], call_id: str | None = None
    ) -> Any:
        """Skill 调用派发入口：八步原子时序（#8），block 走被拦七步。"""
        parent = self._require_parent(f"execute_tool({name!r})")
        trace_id, agent_id = parent.trace_id, parent.agent_id
        span_id = secrets.token_hex(8)  # ①

        attributes = {
            "gen_ai.operation.name": "execute_tool",
            "gen_ai.tool.name": name,
            "service.name": agent_id,
        }
        if call_id is not None:
            attributes["gen_ai.tool.call.id"] = call_id

        # ② span 落库（end=NULL）→ event_log(span.start) → SSE
        start_ns = self._clock()
        self._storage.start_span(
            trace_id, span_id, parent.span_id, f"execute_tool {name}",
            "INTERNAL", start_ns, attributes, agent_id,
        )
        self._emit_span_event("span.start", self._start_payload(
            trace_id, span_id, parent.span_id, f"execute_tool {name}",
            "INTERNAL", start_ns, agent_id,
        ))
        token = _current_span.set(_SpanContext(trace_id, span_id, agent_id))
        try:
            # ③ 同步求值（引擎纯函数，不碰 DB）
            verdict = self._engine.evaluate(
                name, args, EvalContext(agent_id, trace_id, span_id)
            )
            # ④ 审计落库（无论 verdict；payload 快照 + trace_id/span_id）
            self._write_audit(name, args, verdict, trace_id, span_id, agent_id)

            if verdict.verdict == "block":
                # ⑤（block）不执行 fn
                self._finish_blocked(span_id, attributes, verdict, start_ns)  # ⑥⑦
                # ⑧ block → 抛 PolicyBlocked
                raise PolicyBlocked(verdict.matched_rule, verdict.reason or "",
                                    trace_id, span_id)

            # ⑤（allow）执行 fn
            try:
                result = fn()
            except Exception as e:
                # ⑥ fn 异常 → ERROR + exception 事件 + error.type=类名
                events = [{
                    "name": "exception",
                    "timestamp": self._clock(),
                    "attributes": {
                        "exception.type": type(e).__name__,
                        "exception.message": str(e),
                        "exception.stacktrace": traceback.format_exc(),
                    },
                }]
                final_attrs = {**attributes, "error.type": type(e).__name__}
                self._finish_span(span_id, start_ns, "ERROR", str(e),
                                  final_attrs, events)
                raise  # ⑧ fn 异常原样重抛
            else:
                # ⑥ 成功保持 UNSET（不写 OK）。verdict 属性写入时机（trace 契约 §3.4 /
                # policy 契约 §5）：block 必写（见 _finish_blocked）；allow 仅**观察期命中**
                # 时写 verdict/matched_rule 两键（无 error.type / block_reason）；
                # 未命中规则的成功调用不写。
                final_attrs = attributes
                if verdict.matched_rule is not None:
                    final_attrs = {
                        **attributes,
                        "skill_observability.verdict": "allow",
                        "skill_observability.matched_rule": verdict.matched_rule,
                    }
                self._finish_span(span_id, start_ns, "UNSET", None,
                                  final_attrs, [])
                return result  # ⑧
        finally:
            _current_span.reset(token)

    # ---------------------------------------------------------------- 内部：受管 span（agent_run / chat 共用）

    @contextmanager
    def _managed_span(self, *, trace_id: str, parent_span_id: str | None,
                      span_id: str, agent_id: str, name: str, kind: str,
                      attributes: dict):
        start_ns = self._clock()
        self._storage.start_span(trace_id, span_id, parent_span_id, name,
                                 kind, start_ns, attributes, agent_id)
        self._emit_span_event("span.start", self._start_payload(
            trace_id, span_id, parent_span_id, name, kind, start_ns, agent_id,
        ))
        token = _current_span.set(_SpanContext(trace_id, span_id, agent_id))
        handle = SpanHandle(trace_id, span_id, attributes, [])
        try:
            yield handle
        except Exception as e:
            events = [*handle._events, {
                "name": "exception",
                "timestamp": self._clock(),
                "attributes": {
                    "exception.type": type(e).__name__,
                    "exception.message": str(e),
                    "exception.stacktrace": traceback.format_exc(),
                },
            }]
            final_attrs = {**handle._attributes, "error.type": type(e).__name__}
            self._finish_span(span_id, start_ns, "ERROR", str(e),
                              final_attrs, events)
            raise
        else:
            self._finish_span(span_id, start_ns, "UNSET", None,
                              handle._attributes, handle._events)
        finally:
            _current_span.reset(token)

    # ---------------------------------------------------------------- 内部：落库 / 事件 / 审计

    @staticmethod
    def _start_payload(trace_id: str, span_id: str, parent_span_id: str | None,
                       name: str, kind: str, start_ns: int, agent_id: str) -> str:
        # span.start 最小字段（trace 契约 §3.2）
        return json.dumps({
            "trace_id": trace_id,
            "span_id": span_id,
            "parent_span_id": parent_span_id,
            "name": name,
            "kind": kind,
            "start_time_unix_nano": start_ns,
            "agent_id": agent_id,
        }, ensure_ascii=False)

    def _finish_span(self, span_id: str, start_ns: int, status_code: str,
                     status_message: str | None, attributes: dict,
                     events: list[dict]) -> None:
        # ⑥ span UPDATE 补时长与状态 → ⑦ event_log(span.end)（整行快照）→ SSE
        row = self._storage.end_span(span_id, self._clock(), status_code,
                                     status_message, attributes, events)
        self._emit_span_event("span.end", json.dumps(row, ensure_ascii=False))

    def _finish_blocked(self, span_id: str, base_attrs: dict,
                        verdict: Verdict, start_ns: int) -> None:
        # ⑥ block → ERROR + error.type="policy.block" + skill_observability.*
        final_attrs = {
            **base_attrs,
            "error.type": "policy.block",
            "skill_observability.verdict": "block",
            "skill_observability.matched_rule": verdict.matched_rule,
            "skill_observability.block_reason": verdict.reason,
        }
        self._finish_span(span_id, start_ns, "ERROR", verdict.reason, final_attrs, [])

    def _emit_span_event(self, kind: str, payload_json: str) -> None:
        # event_log 落库之后、广播之前（trace 契约 §1.3 时序）
        event_id = self._storage.insert_event(kind, self._clock(), payload_json)
        self._hub.publish(kind, event_id, payload_json)

    def _write_audit(self, tool_name: str, args: Any, verdict: Verdict,
                     trace_id: str, span_id: str, agent_id: str) -> None:
        rule = self._engine.rule_by_id(verdict.matched_rule) if verdict.matched_rule else None
        payload_json = json.dumps(args, ensure_ascii=False)
        stored_payload = payload_json
        if len(payload_json.encode("utf-8")) > _AUDIT_PAYLOAD_CAP_BYTES:
            # 截断（按字节、保持可解析）；标志与「内容是否真被切」严格一致
            stored_payload = _truncate_json_text(payload_json, _AUDIT_PAYLOAD_CAP_BYTES)
            truncated = True
        else:
            truncated = False
        self._storage.insert_audit(
            trace_id=trace_id,
            span_id=span_id,
            agent_id=agent_id,
            tool_name=tool_name,
            verdict=verdict.verdict,
            rule_id=verdict.matched_rule,
            rule_name=rule.name if rule else None,
            action=rule.action if rule else None,
            reason=verdict.reason,
            payload_json=stored_payload,
            payload_truncated=truncated,
            created_at_unix_nano=self._clock(),
        )

    @staticmethod
    def _require_parent(where: str) -> _SpanContext:
        parent = _current_span.get()
        if parent is None:
            raise RuntimeError(f"{where} 必须嵌在 agent_run() 上下文内（无活跃根 span）")
        return parent
