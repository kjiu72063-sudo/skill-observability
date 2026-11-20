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


def query_contact_by_phone(args: dict) -> dict:
    """按手机号查客户联系资料（#13 第二拍：r1b 观察期规则的命中路径）。"""
    phone = args.get("phone")
    profile = config.USER_PROFILES.get(phone)
    if profile is None:
        return {"found": False, "phone": phone, "message": "未找到该手机号对应的客户资料"}
    return {"found": True, "profile": profile}


def verify_customer_id(args: dict) -> dict:
    """按身份证号查实名核验信息（#13 第三拍：r1 拦截，demo 中 fn 不会执行）。"""
    id_card = args.get("id_card")
    record = config.REALNAME_RECORDS.get(id_card)
    if record is None:
        return {"verified": False, "id_card": id_card, "message": "实名库无记录"}
    return {"verified": True, "record": record}


def create_callback_request(args: dict) -> dict:
    """构造合成的本地回电请求，不联系客户或外部服务。"""
    order_id = args.get("order_id")
    if order_id not in config.ORDERS:
        return {"created": False, "order_id": order_id, "message": "订单不存在"}
    return {
        "created": True,
        "request": {
            "request_id": f"callback-{order_id}",
            "order_id": order_id,
            "timing": "派送前",
            "status": "待回电",
        },
    }


def get_delivery_eta(args: dict) -> dict:
    """仅查询合成订单的预计配送时间。"""
    order_id = args.get("order_id")
    order = config.ORDERS.get(order_id)
    if order is None:
        return {"found": False, "order_id": order_id, "message": "订单不存在"}
    return {"found": True, "order_id": order_id, "eta": order["eta"]}


# 工具注册表：name → 实现（execute_tool 拦截通过后才执行）
TOOL_IMPLS: dict[str, Callable[[dict], Any]] = {
    "query_user_db": query_user_db,
    "query_contact_by_phone": query_contact_by_phone,
    "verify_customer_id": verify_customer_id,
    "create_callback_request": create_callback_request,
    "get_delivery_eta": get_delivery_eta,
}
