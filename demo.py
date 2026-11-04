"""单命令入口：``python demo.py``（#12 钉死的生命周期，#10 人验1/人验5 的唯一自洽机制）。

- 起服务（同进程 uvicorn 后台线程，#8 决议 4）→ 自动跑一遍客服场景第一拍
  「查订单（allow）」→ 打印（树 + 本 run 审计，走查询 API）→ **进程不退出**。
- 提示「回车重跑 / Ctrl+C 退出」；回车 = 同进程内重跑：新 trace、DB 累积、SSE 续推。
  不允许「再开一个 python demo.py」——会端口冲突，且第二个进程写的 span
  不会出现在第一个进程的 SSE 流里（#8 决议 4 已把跨进程推送延期）。
- 人验5：另开终端 ``curl -N http://127.0.0.1:8000/api/events`` → 首连收到全量
  回放 → 回车重跑 → curl 实时收到新 run 的 span.start / span.end。
- pytest 不走交互循环：交互包装只属于本入口；场景运行暴露为可导入函数
  （:func:`bootstrap` / :func:`run_first_beat`）与 ASGI app（app.create_app）。
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from pathlib import Path

import uvicorn

from scenario.customer_service.agent import run_customer_service_turn
from scenario.customer_service.config import CASSETTE_PATH, DEMO_USER_MESSAGE, MODEL
from scenario.customer_service.llm import ReplayLlmClient

if __package__ in (None, ""):  # 直接以脚本运行（python demo.py）
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from skill_observability.app import create_app  # noqa: E402
from skill_observability.db import Storage  # noqa: E402
from skill_observability.engine import PolicyEngine  # noqa: E402
from skill_observability.printing import print_run_audits, print_trace_tree  # noqa: E402
from skill_observability.sdk import ObservabilitySdk  # noqa: E402
from skill_observability.sse import EventHub  # noqa: E402

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "demo.db"
SEED_PATH = BASE_DIR / "seed" / "rules.json"
HOST = "127.0.0.1"
DEFAULT_PORT = 8000


class DemoDeps:
    """进程内共享装配：storage / engine / hub + 可导入的场景入口。"""

    def __init__(self, port: int = DEFAULT_PORT):
        # 每次进程启动 = 全新 DB（首跑后 /api/audits 恰一行可验收；回车重跑在
        # 进程内累积，DB 文件跨进程重启不保留演示脏数据）
        DB_PATH.unlink(missing_ok=True)
        self.storage = Storage(DB_PATH)
        now = time.time_ns()
        seed = json.loads(SEED_PATH.read_text(encoding="utf-8"))
        seeded = self.storage.seed_rules_if_empty(seed, now)
        if seeded == 0:
            raise RuntimeError("种子播种被跳过：新建的库 rule 表非空（异常状态）")
        self.engine = PolicyEngine()
        # M1 启动加载（#11：无写路径，启动加载即可满足；M2 接管版本比对）
        self.engine.reload(self.storage.load_rule_rows(), self.storage.get_rules_version())
        self.hub = EventHub()
        self.sdk = ObservabilitySdk(self.storage, self.engine, self.hub)
        self.llm = ReplayLlmClient(CASSETTE_PATH, model=MODEL)
        self.port = port

    @property
    def base_url(self) -> str:
        return f"http://{HOST}:{self.port}"

    def make_asgi_app(self):
        return create_app(self.storage, self.engine, self.hub)


def run_first_beat(deps: DemoDeps) -> str:
    """跑第一拍「查订单（allow）」，返回 trace_id（可导入，供测试/复用）。"""
    run_start = time.time_ns()
    result = run_customer_service_turn(deps.sdk, deps.llm, DEMO_USER_MESSAGE)
    print()
    print_trace_tree(deps.base_url, result.trace_id)
    print()
    print(f"答复：{result.answer}")
    print()
    print_run_audits(deps.base_url, run_start)
    return result.trace_id


def _start_server(deps: DemoDeps) -> uvicorn.Server:
    config = uvicorn.Config(
        deps.make_asgi_app(), host=HOST, port=deps.port, log_level="warning"
    )
    server = uvicorn.Server(config)
    threading.Thread(target=server.run, daemon=True, name="demo-uvicorn").start()
    deadline = time.monotonic() + 10
    while not server.started:
        if time.monotonic() > deadline:
            raise RuntimeError("uvicorn 启动超时")
        time.sleep(0.05)
    return server


def main() -> None:
    port = int(os.environ.get("DEMO_PORT", str(DEFAULT_PORT)))
    deps = DemoDeps(port=port)
    _start_server(deps)
    print("=" * 64)
    print("skill-observability M1 demo（客服场景 · 第一拍：查订单 allow）")
    print(f"  查询 API / SSE：{deps.base_url}  （实时流：curl -N {deps.base_url}/api/events）")
    print("  生命周期：起服务 → 自动跑一遍 → 回车重跑（同进程，新 trace）/ Ctrl+C 退出")
    print("=" * 64)

    first = True
    while True:
        if first:
            first = False
        else:
            try:
                input("\n—— 回车重跑本拍（同进程内：新 trace、DB 累积、SSE 续推）——")
            except (EOFError, KeyboardInterrupt):
                print("\n退出。")
                return
        run_first_beat(deps)
        # 跑完不退出：提示语在下一轮循环的 input 里


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n退出。")
