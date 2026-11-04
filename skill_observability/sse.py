"""同进程 SSE 广播总线（#8 决议 4：进程内直连写库 + 同进程直推 SSE）。

发布方（SDK，任意线程）→ :meth:`EventHub.publish`；
订阅方（SSE 端点，uvicorn 事件循环线程）→ :meth:`EventHub.subscribe` 拿到
绑定当前事件循环的 ``asyncio.Queue``。跨线程投递用
``loop.call_soon_threadsafe``，队列无界——演示规模下不丢事件。
"""

from __future__ import annotations

import asyncio
import threading
from dataclasses import dataclass


@dataclass(eq=False)  # eq=False：按对象身份哈希，才能进 set
class _Subscriber:
    loop: asyncio.AbstractEventLoop
    queue: asyncio.Queue


class EventHub:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._subscribers: set[_Subscriber] = set()

    def subscribe(self) -> _Subscriber:
        """在 SSE 端点（事件循环线程）内调用。"""
        sub = _Subscriber(loop=asyncio.get_running_loop(), queue=asyncio.Queue())
        with self._lock:
            self._subscribers.add(sub)
        return sub

    def unsubscribe(self, sub: _Subscriber) -> None:
        with self._lock:
            self._subscribers.discard(sub)

    def publish(self, kind: str, event_id: int, payload_json: str) -> None:
        """任意线程可调：把 (kind, event_id, payload) 投给所有订阅者。"""
        with self._lock:
            subs = list(self._subscribers)
        for sub in subs:
            try:
                sub.loop.call_soon_threadsafe(
                    sub.queue.put_nowait, (kind, event_id, payload_json)
                )
            except RuntimeError:
                # 事件循环已关闭（进程退出中）：订阅者即将被清理，忽略
                pass
