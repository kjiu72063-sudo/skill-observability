"""客服场景（M1 第一拍：查订单 allow）。粗糙版，#9 彩排后定稿重录/调整。"""

from scenario.customer_service.agent import RunResult, run_customer_service_turn
from scenario.customer_service.config import (
    AGENT_ID,
    CASSETTE_PATH,
    DEMO_USER_MESSAGE,
    MODEL,
    SYSTEM_PROMPT,
    TEMPERATURE,
    TOOLS,
)

__all__ = [
    "AGENT_ID",
    "CASSETTE_PATH",
    "DEMO_USER_MESSAGE",
    "MODEL",
    "SYSTEM_PROMPT",
    "TEMPERATURE",
    "TOOLS",
    "RunResult",
    "run_customer_service_turn",
]
