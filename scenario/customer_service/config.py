"""客服场景配置：系统提示词 + 工具清单 + 预置数据（地图 Notes；规则不进场景配置）。"""

from __future__ import annotations

from pathlib import Path

AGENT_ID = "customer-service"
MODEL = "gpt-4o-mini"
TEMPERATURE = 0  # replay 档序列化确定性（issue #12 验收：temperature 固定）

# cassette 路径：scenario/cassettes/customer-service.yaml（手写粗糙版，#9 定稿后重录）
CASSETTE_PATH = (
    Path(__file__).resolve().parent.parent / "cassettes" / "customer-service.yaml"
)

SYSTEM_PROMPT = (
    "你是电商客服助手。回答用户问题前，先通过提供的工具查询订单系统，"
    "不要凭记忆编造订单信息；查到后用一句话简洁答复用户。"
)

# 工具清单（顺序稳定：cassette body 匹配对数组序敏感）
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "query_user_db",
            "description": "查询订单数据库，返回订单的物流状态等最新信息",
            "parameters": {
                "type": "object",
                "properties": {
                    "order_id": {
                        "type": "string",
                        "description": "订单号，如 20241025001",
                    }
                },
                "required": ["order_id"],
            },
        },
    }
]

# 预置数据（合成数据，无真实 PII；查订单参数不含身份证号/手机号模式）
ORDERS = {
    "20241025001": {
        "order_id": "20241025001",
        "status": "已发货",
        "carrier": "顺丰速运",
        "tracking_no": "SF1234567890",
        "eta": "2026-11-06",
        "items": [{"sku": "KB-87-GRID", "name": "无线机械键盘", "qty": 1}],
    }
}

# 第一拍用户消息（演示脚本固定，cassette 与之严格一致）
DEMO_USER_MESSAGE = "帮我查一下订单 20241025001 现在到哪了"
