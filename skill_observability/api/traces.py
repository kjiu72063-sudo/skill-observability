"""``GET /api/traces``、``GET /api/traces/{trace_id}``（契约 trace §2.1/§2.2 原样）。"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from skill_observability.db import Storage


def build_traces_router(storage: Storage) -> APIRouter:
    router = APIRouter()

    @router.get("/api/traces")
    async def list_traces(
        agent_id: str | None = Query(default=None, description="精确匹配 root span 的 agent_id"),
        from_ns: int | None = Query(default=None, alias="from",
                                    description="root start_time_unix_nano >= from"),
        to: int | None = Query(default=None, description="root start_time_unix_nano <= to"),
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=20, ge=1, le=100),
    ) -> dict:
        # 以 root span（parent_span_id IS NULL）为行单位，start 倒序（契约 §2.1）
        items, total = storage.list_traces(agent_id, from_ns, to, page, page_size)
        return {"items": items, "page": page, "page_size": page_size, "total": total}

    @router.get("/api/traces/{trace_id}")
    async def trace_detail(trace_id: str) -> dict:
        # 平铺 spans 数组按 start 升序（契约 §2.2）；树形由前端按 parent_span_id 构建
        spans = storage.get_trace_spans(trace_id)
        if spans is None:
            raise HTTPException(status_code=404, detail="trace not found")
        return {"trace_id": trace_id, "spans": spans}

    return router
