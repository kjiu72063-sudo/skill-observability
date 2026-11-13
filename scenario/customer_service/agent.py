"""客服场景 agent：通用多轮工具循环。

树形（#10：chat 包住整轮——工具 span 是当轮 chat span 的子 span，树三层）::

    invoke_agent customer-service        (根，INTERNAL)
    ├─ chat gpt-4o-mini                  (CLIENT，包住本轮 LLM 调用 + 工具执行)
    │  └─ execute_tool query_user_db     (INTERNAL，allow 未命中)
    ├─ chat gpt-4o-mini
    │  └─ execute_tool query_contact_by_phone   (INTERNAL，r1b 观察期命中，verdict 仍 allow)
    └─ chat gpt-4o-mini
       └─ execute_tool verify_customer_id       (INTERNAL，r1 拦截 ERROR)

PolicyBlocked 在子任务边界（Skill 调用处）捕获 → 终止报告 → 终止，不重试（#8 决议 3，
#10 人验3）；拦截语义由工具 span 的 ERROR + error.type="policy.block" 承载，root/chat
正常收口（#13 实现备注：root 终态 UNSET）。

演示节奏（#21）：真实一次 run 只有 70–250ms、事件间隔中位 4ms，「逐个生长」肉眼不可见。
``DEMO_PACE_MS``（默认 0 = 零行为变化）在两个节奏点插入 sleep——进入 chat span 后、
调 LLM 前；工具 fn 内、执行前。已知边界：被拦 span 的 fn 不执行（#8 决议 1），
故其 spinner 仍是一瞬；验收口径 = 「两次工具 spinner 可见 + 第三次瞬变红」。
"""

from __future__ import annotations

import functools
import json
import os
import time
from dataclasses import dataclass

from skill_observability.sdk import ObservabilitySdk, PolicyBlocked

from scenario.customer_service.config import AGENT_ID, MODEL, SYSTEM_PROMPT, TOOLS
from scenario.customer_service.llm import LlmResponse, ReplayLlmClient, ToolCall
from scenario.customer_service.tools import TOOL_IMPLS


def _pace_ms() -> float:
    """演示节奏（毫秒）：0/非法/负数一律 0（默认路径零行为变化）。"""
    raw = os.environ.get("DEMO_PACE_MS", "0")
    try:
        ms = float(raw)
    except ValueError:
        return 0.0
    return ms if ms > 0 else 0.0


def _paced_tool_call(name: str, args: dict, pace: float):
    """节奏点 2（#21）：工具 fn 内先 sleep 再执行（pace=0 时零开销）。

    被拦调用 fn 根本不执行（#8 决议 1「block 则 fn 绝不执行」），故被拦 span 的
    spinner 仍是一瞬——这是已知边界，不为演示节奏改 SDK。
    """
    if pace > 0:
        time.sleep(pace)
    return TOOL_IMPLS[name](args)


@dataclass(frozen=True)
class RunResult:
    trace_id: str
    answer: str


def run_customer_service_turn(
    sdk: ObservabilitySdk, llm: ReplayLlmClient, user_message: str
) -> RunResult:
    """跑一轮客服任务：agent_run 根 span → 多轮 chat/execute_tool → 最终答复。"""
    messages: list[dict] = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_message},
    ]
    with sdk.agent_run(AGENT_ID) as root:
        answer = _tool_loop(sdk, llm, messages)
    return RunResult(trace_id=root.trace_id, answer=answer)


def _tool_loop(sdk: ObservabilitySdk, llm: ReplayLlmClient, messages: list[dict]) -> str:
    pace = _pace_ms() / 1000.0
    while True:
        # chat 包住整轮：本轮 LLM 调用与其派生的工具调用都落在该 chat span 内
        with sdk.chat(model=MODEL) as chat_handle:
            # 节奏点 1（#21）：chat span 已开、LLM 未调——让 chat 的「进行中」可见
            if pace > 0:
                time.sleep(pace)
            resp: LlmResponse = llm.chat(messages, TOOLS)
            if resp.usage is not None:
                chat_handle.set_attribute("gen_ai.usage.input_tokens", resp.usage[0])
                chat_handle.set_attribute("gen_ai.usage.output_tokens", resp.usage[1])
            if not resp.tool_calls:
                return resp.content or ""
            messages.append(_assistant_tool_call_message(resp.tool_calls))
            for tc in resp.tool_calls:
                try:
                    result = sdk.execute_tool(
                        tc.name, tc.args,
                        # 节奏点 2（#21）：工具 fn 内先 sleep 再执行——让工具 spinner 可见。
                        # 被拦调用 fn 不执行（#8 决议 1），其 spinner 仍是一瞬（已知边界）。
                        functools.partial(_paced_tool_call, tc.name, tc.args, pace),
                        call_id=tc.call_id,
                    )
                except PolicyBlocked as pb:
                    # 子任务边界：终止报告 → 终止（不重试、不改道，#8 决议 3 / #10 人验3；
                    # 文案粗糙可，对话质量归 #9）。异常在本 with 块内被捕获，chat span 正常收口。
                    return (
                        "[终止报告] 本次任务在 Skill 调用处被合规策略拦截，已终止（不重试、不改道）。\n"
                        f"  被拦调用：{tc.name}\n"
                        f"  命中规则：{pb.matched_rule}\n"
                        f"  理由：{pb.block_reason}\n"
                        f"  trace 关联：trace {pb.trace_id} / span {pb.span_id}"
                    )
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc.call_id,
                    "content": json.dumps(result, ensure_ascii=False),
                })


def _assistant_tool_call_message(tool_calls: list[ToolCall]) -> dict:
    """把 LLM 返回的工具调用还原为 openai 协议的 assistant 消息（下一轮请求体）。"""
    return {
        "role": "assistant",
        "content": None,
        "tool_calls": [
            {
                "id": tc.call_id,
                "type": "function",
                "function": {
                    "name": tc.name,
                    "arguments": json.dumps(tc.args, ensure_ascii=False),
                },
            }
            for tc in tool_calls
        ],
    }
