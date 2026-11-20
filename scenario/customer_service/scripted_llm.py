"""仅用于本地测试的三步 LLM；不装配到 demo，不访问网络或密钥。

返回对象与现有 agent 的 chat 接口兼容。独立定义数据对象，避免导入网络客户端。
后续入参从实际工具结果派生，不内置手机号或身份证号。
"""

from __future__ import annotations

import json
from dataclasses import dataclass


@dataclass(frozen=True)
class ToolCall:
    call_id: str
    name: str
    args: dict


@dataclass(frozen=True)
class LlmResponse:
    content: str | None
    tool_calls: list[ToolCall]
    usage: tuple[int, int] | None = None


class ScriptedLlmClient:
    """每个实例依次尝试订单、联系方式、实名；三步后不再产生工具调用。"""

    def __init__(self):
        self._step = 0

    def chat(self, messages: list[dict], tools: list[dict]) -> LlmResponse:
        if self._step >= 3:
            return LlmResponse(content="受控三步序列结束。", tool_calls=[])

        if self._step == 0:
            name = "query_user_db"
            args = {"order_id": "20241025001"}
        else:
            if not messages or messages[-1].get("role") != "tool":
                raise ValueError("受控序列缺少上一工具结果")
            result = json.loads(messages[-1]["content"])
            if self._step == 1:
                name = "query_contact_by_phone"
                args = {"phone": result["order"]["customer_phone"]}
            else:
                name = "verify_customer_id"
                args = {"id_card": result["profile"]["id_card"]}

        self._step += 1
        return LlmResponse(
            content=None,
            tool_calls=[ToolCall(f"scripted-{self._step}", name, args)],
        )
