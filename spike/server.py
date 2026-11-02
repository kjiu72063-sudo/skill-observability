"""stack-spike: FastAPI + SQLite + SSE 单命令本地启动的最小骨架。

运行:
    python server.py
然后打开 http://127.0.0.1:8000/ 即可看到事件实时推送。

范围锁: 无 OTel collector/exporter, 无 Docker。
"""
from __future__ import annotations

import asyncio
import json
import os
import random
import sqlite3
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, Header
from fastapi.sse import EventSourceResponse, ServerSentEvent
from fastapi.staticfiles import StaticFiles

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# 优先托管 Vite 构建产物(演示路径), 没有构建过则退回内置演示页。
VITE_DIST = os.path.join(BASE_DIR, "frontend", "dist")
STATIC_DIR = VITE_DIST if os.path.isdir(VITE_DIST) else os.path.join(BASE_DIR, "static")
DB_PATH = os.path.join(BASE_DIR, "spike.db")

# ---------------------------------------------------------------- SQLite
db = sqlite3.connect(DB_PATH, check_same_thread=False)
db.row_factory = sqlite3.Row
db.execute(
    """
    CREATE TABLE IF NOT EXISTS event (
        id   INTEGER PRIMARY KEY AUTOINCREMENT,
        ts   REAL NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL
    )
    """
)
db.commit()


def insert_event(kind: str, payload: dict) -> dict:
    cur = db.execute(
        "INSERT INTO event (ts, kind, payload) VALUES (?, ?, ?)",
        (time.time(), kind, json.dumps(payload, ensure_ascii=False)),
    )
    db.commit()
    return {"id": cur.lastrowid, "kind": kind, "payload": payload}


# ---------------------------------------------------------------- SSE 广播总线
subscribers: set[asyncio.Queue] = set()


async def broadcast(evt: dict) -> None:
    for q in list(subscribers):
        await q.put(evt)


# ---------------------------------------------------------------- 演示事件源
DEMO_KINDS = [
    ("span.start", {"tool": "search_orders", "trace_id": "t-1001"}),
    ("span.end", {"tool": "search_orders", "status": "ok", "dur_ms": 312}),
    ("verdict", {"tool": "send_email", "verdict": "allow"}),
    ("verdict", {"tool": "shell_exec", "verdict": "block",
                 "rule": "R2-dangerous-command"}),
]


async def demo_loop() -> None:
    """模拟 agent 侧埋点: 落 SQLite 并广播给所有 SSE 客户端。"""
    while True:
        kind, payload = random.choice(DEMO_KINDS)
        evt = insert_event(kind, payload)
        await broadcast(evt)
        await asyncio.sleep(1.5)


@asynccontextmanager
async def lifespan(_: FastAPI):
    task = asyncio.create_task(demo_loop())
    yield
    task.cancel()


# ---------------------------------------------------------------- App
app = FastAPI(title="stack-spike", lifespan=lifespan)

# 选型①: 静态资源由 FastAPI 托管(演示路径 = 单进程)。
# app.frontend() 内部即 StaticFiles, 额外提供 SPA fallback; 旧版退回 mount。
if hasattr(app, "frontend"):
    app.frontend("/", directory=STATIC_DIR, fallback="index.html")
else:  # pragma: no cover - 兼容旧版 FastAPI
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")


@app.get("/api/health")
async def health() -> dict:
    n = db.execute("SELECT COUNT(*) AS c FROM event").fetchone()["c"]
    return {"ok": True, "events": n}


@app.get("/api/events", response_class=EventSourceResponse)
async def sse_stream(
    last_event_id: int | None = Header(default=None, alias="Last-Event-ID"),
) -> AsyncIterator[ServerSentEvent]:
    """选型②: SSE —— 服务端单向推送 trace 事件(浏览器 EventSource 原生消费)。

    注意: EventSourceResponse 的 wire-format 编码在 FastAPI 路由层完成,
    必须用 response_class + 在本函数内 yield, 不能自行 return 一个
    EventSourceResponse(否则 ServerSentEvent 不会被编码)。
    """
    # 先订阅再回放, 避免回放期间(yield 让出事件循环)漏掉实时事件;
    # 回放后按 id 去重即可。
    queue: asyncio.Queue = asyncio.Queue()
    subscribers.add(queue)
    try:
        start = last_event_id or 0
        rows = db.execute(
            "SELECT * FROM event WHERE id > ? ORDER BY id", (start,)
        ).fetchall()
        replayed = 0
        for r in rows:
            replayed = r["id"]
            yield ServerSentEvent(
                event="trace",
                id=str(r["id"]),
                data={"id": r["id"], "kind": r["kind"],
                      "payload": json.loads(r["payload"])},
            )
        while True:
            evt = await queue.get()
            if evt["id"] <= replayed:  # 回放已覆盖, 去重
                continue
            yield ServerSentEvent(
                event="trace", id=str(evt["id"]), data=evt
            )
    finally:
        subscribers.discard(queue)


if __name__ == "__main__":
    print("stack-spike 已启动: http://127.0.0.1:8000/  (Ctrl+C 退出)")
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="warning")
