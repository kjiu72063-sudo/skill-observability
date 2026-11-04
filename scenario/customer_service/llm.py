"""LLM 客户端（replay 档）：vcrpy cassette 回放，零网络、零密钥、可重复（#10 决议）。

M1 只有 replay 档：live 直连与 API 失败降级不做（issue #12 边界）。
#5 结论要点落实：
- ``match_on`` 必须含 ``body``（默认匹配器不含 body，不同 prompt 同 URL 会串台）；
- vcrpy body 匹配器对 application/json 请求做 JSON 解析后比较——dict 键序/空白
  不敏感，**数组序敏感**，故 prompt 与工具 schema 顺序必须稳定（temperature 固定 0）；
- ``allow_playback_repeats=True``：同一请求重复发送时允许重复播放；
- ``max_retries=0``：录制与回放用同一重试设置，交互序列才对得上。
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

import vcr
from openai import OpenAI


@dataclass(frozen=True)
class ToolCall:
    call_id: str
    name: str
    args: dict


@dataclass(frozen=True)
class LlmResponse:
    content: str | None
    tool_calls: list[ToolCall]
    usage: tuple[int, int] | None  # (prompt_tokens, completion_tokens)


# body 必含（#5 结论；固化成常量防漏）
MATCH_ON = ["method", "scheme", "host", "port", "path", "query", "body"]


class ReplayLlmClient:
    """把 openai SDK 的 HTTP 交互按 cassette 回放的 LLM 客户端。"""

    def __init__(self, cassette_path: str | Path, model: str, temperature: float = 0):
        self._cassette_path = Path(cassette_path)
        self._model = model
        self._temperature = temperature
        # replay 档无网络：占位 key 即可（cassette 不校验）；显式给出避免环境依赖
        api_key = os.environ.get("OPENAI_API_KEY") or "replay-dummy-key"
        self._client = OpenAI(api_key=api_key, max_retries=0)

    def chat(self, messages: list[dict], tools: list[dict]) -> LlmResponse:
        with vcr.use_cassette(
            str(self._cassette_path),
            record_mode="none",  # replay 档：零网络，未覆盖的请求直接抛错
            match_on=MATCH_ON,
            allow_playback_repeats=True,
            filter_headers=("Authorization",),  # 录制脱敏惯例；回放不参与匹配
        ):
            resp = self._client.chat.completions.create(
                model=self._model,
                messages=messages,
                tools=tools,
                temperature=self._temperature,
            )
        return _parse_response(resp)


def _parse_response(resp) -> LlmResponse:
    message = resp.choices[0].message
    tool_calls = [
        ToolCall(
            call_id=tc.id,
            name=tc.function.name,
            args=json.loads(tc.function.arguments or "{}"),
        )
        for tc in (message.tool_calls or [])
    ]
    usage = (
        (resp.usage.prompt_tokens, resp.usage.completion_tokens) if resp.usage else None
    )
    return LlmResponse(content=message.content, tool_calls=tool_calls, usage=usage)
