"""客服场景 agent：通用多轮工具循环。

树形（#10：chat 包住整轮——工具 span 是当轮 chat span 的子 span，树三层）::

    invoke_agent customer-service        (根，INTERNAL)
    └─ chat gpt-4o-mini                  (CLIENT，包住本轮 LLM 调用 + 工具执行)
       └─ execute_tool query_user_db     (INTERNAL)

PolicyBlocked 在子任务边界（工具调用处）捕获 → 报告 → 终止，不重试（#8 决议 3）。
本票（#12）只演练第一拍 allow 分支；观察期/拦截两拍归子票 2（分支已就位）。
"""

from __future__ import annotations

import json
from dataclasses import dataclass

from skill_observability.sdk import ObservabilitySdk, PolicyBlocked

from scenario.customer_service.config import AGENT_ID, MODEL, SYSTEM_PROMPT, TOOLS
from scenario.customer_service.llm import LlmResponse, ReplayLlmClient, ToolCall
from scenario.customer_service.tools import TOOL_IMPLS


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
    while True:
        # chat 包住整轮：本轮 LLM 调用与其派生的工具调用都落在该 chat span 内
        with sdk.chat(model=MODEL) as chat_handle:
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
                        lambda n=tc.name, a=tc.args: TOOL_IMPLS[n](a),
                        call_id=tc.call_id,
                    )
                except PolicyBlocked as pb:
                    # 子任务边界：报告 → 终止（不重试、不改道）
                    return (
                        f"[任务终止] Skill 调用被策略拦截：{pb.block_reason}"
                        f"（规则 {pb.matched_rule}，trace {pb.trace_id} span {pb.span_id}）"
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
