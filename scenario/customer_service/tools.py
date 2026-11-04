"""客服场景工具实现（预置数据查询，真实执行、无桩）。"""

from __future__ import annotations

from typing import Any, Callable

from scenario.customer_service import config


def query_user_db(args: dict) -> dict:
    order_id = args.get("order_id")
    order = config.ORDERS.get(order_id)
    if order is None:
        return {"found": False, "order_id": order_id, "message": "订单不存在"}
    return {"found": True, "order": order}


# 工具注册表：name → 实现（execute_tool 拦截通过后才执行）
TOOL_IMPLS: dict[str, Callable[[dict], Any]] = {
    "query_user_db": query_user_db,
}
