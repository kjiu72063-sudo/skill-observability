"""``GET /api/audits``（契约 policy §3.2 原样；分页形状沿用 trace §2.1）。"""

from __future__ import annotations

from fastapi import APIRouter, Query

from skill_observability.db import Storage


def build_audits_router(storage: Storage) -> APIRouter:
    router = APIRouter()

    @router.get("/api/audits")
    async def list_audits(
        verdict: str | None = Query(default=None, pattern="^(allow|block)$"),
        agent_id: str | None = None,
        tool_name: str | None = None,
        rule_id: str | None = None,
        from_ns: int | None = Query(default=None, alias="from"),
        to: int | None = None,
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=20, ge=1, le=100),
    ) -> dict:
        items, total = storage.list_audits(
            verdict, agent_id, tool_name, rule_id, from_ns, to, page, page_size
        )
        return {"items": items, "page": page, "page_size": page_size, "total": total}

    return router
