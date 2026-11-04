"""``GET /api/events``——SSE 回放 + 实时（契约 trace §3）。

- 先订阅再回放（订阅先行，避免回放期间漏实时事件），回放后按 event id 去重。
- 首连（无 Last-Event-ID）从头全量回放；带 Last-Event-ID 则从该 id 之后续发
  （契约 §3.1；M1 不做前端续传，服务端语义照契约实现，curl 可验）。
- wire 格式：``event:`` = kind（span.start/span.end），``id:`` = event_log.id，
  ``data:`` = 发出时的 JSON 快照原样（``raw_data`` 免二次编码）。
- 空闲 keep-alive 注释由 EventSourceResponse 默认行为提供（约 15s）。
"""

from __future__ import annotations

from collections.abc import AsyncIterator

from fastapi import APIRouter, Header
from fastapi.sse import EventSourceResponse, ServerSentEvent

from skill_observability.db import Storage
from skill_observability.sse import EventHub


def build_events_router(storage: Storage, hub: EventHub) -> APIRouter:
    router = APIRouter()

    @router.get("/api/events", response_class=EventSourceResponse)
    async def events(
        last_event_id: int | None = Header(default=None, alias="Last-Event-ID"),
    ) -> AsyncIterator[ServerSentEvent]:
        sub = hub.subscribe()
        try:
            after = last_event_id or 0
            last_replayed = after
            for row in storage.replay_events(after):
                last_replayed = row["id"]
                yield ServerSentEvent(
                    event=row["kind"], id=str(row["id"]), raw_data=row["payload"]
                )
            while True:
                kind, event_id, payload_json = await sub.queue.get()
                if event_id <= last_replayed:
                    continue  # 回放已覆盖（回放期间广播来的）
                yield ServerSentEvent(event=kind, id=str(event_id), raw_data=payload_json)
        finally:
            hub.unsubscribe(sub)

    return router
