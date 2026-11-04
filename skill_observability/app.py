"""FastAPI 应用组装：查询 API×3 + SSE 推送（M1 无规则 CRUD——规则管理归 M2）。"""

from __future__ import annotations

from fastapi import FastAPI

from skill_observability.api import build_audits_router, build_events_router, build_traces_router
from skill_observability.db import Storage
from skill_observability.engine import PolicyEngine
from skill_observability.sse import EventHub


def create_app(storage: Storage, engine: PolicyEngine, hub: EventHub) -> FastAPI:
    """依赖显式注入：storage / engine / hub 由 demo 启动器装配（可导入、可测试）。

    规则播种与引擎快照加载属进程启动职责（demo.py bootstrap），不在 app 内做——
    M1 无规则写路径，engine.evaluate 零 DB 读的语义由「启动加载」满足（#11）。
    """
    app = FastAPI(
        title="skill-observability",
        description="Agent Skill 合规可观测平台（M1 垂直切片）",
        version="0.1.0",
    )
    app.include_router(build_traces_router(storage))
    app.include_router(build_audits_router(storage))
    app.include_router(build_events_router(storage, hub))
    return app
