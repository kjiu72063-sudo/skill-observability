"""单命令入口：``python demo.py``（#12 钉死的生命周期，#10 人验1/人验5 的唯一自洽机制）。

- 起服务（同进程 uvicorn 后台线程，#8 决议 4）→ 自动跑一遍客服场景三拍全程
  （查订单 allow → 手机号观察期 r1b → 身份证拦截 r1 → 终止报告）→ 打印（树 +
  终止报告 + 本 run 审计，走查询 API）→ **进程不退出**。
- 提示「回车重跑 / Ctrl+C 退出」；回车 = 同进程内重跑：新 trace、DB 累积、SSE 续推。
  不允许「再开一个 python demo.py」——会端口冲突，且第二个进程写的 span
  不会出现在第一个进程的 SSE 流里（#8 决议 4 已把跨进程推送延期）。
- 人验5：另开终端 ``curl -N http://127.0.0.1:8000/api/events`` → 首连收到全量
  回放 → 回车重跑 → curl 实时收到新 run 的 span.start / span.end。
- pytest 不走交互循环：交互包装只属于本入口；场景运行暴露为可导入函数
  （:class:`DemoDeps` / :func:`run_demo_turn`）与 ASGI app（app.create_app）。
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from pathlib import Path

if __package__ in (None, ""):  # 直接以脚本运行（python demo.py，任意 cwd）
    sys.path.insert(0, str(Path(__file__).resolve().parent))

try:
    import uvicorn

    from fastapi.staticfiles import StaticFiles

    from skill_observability.app import create_app
    from skill_observability.db import Storage
    from skill_observability.engine import PolicyEngine
    from skill_observability.printing import print_run_audits, print_trace_tree
    from skill_observability.sdk import ObservabilitySdk
    from skill_observability.sse import EventHub
    from scenario.customer_service.agent import run_customer_service_turn
    from scenario.customer_service.config import CASSETTE_PATH, DEMO_USER_MESSAGE, MODEL
    from scenario.customer_service.llm import ReplayLlmClient
except ImportError as e:  # 依赖未装进当前解释器（如 anaconda base）：给出明确指引
    venv_python = (
        r".venv\Scripts\python.exe" if os.name == "nt" else ".venv/bin/python"
    )
    sys.stderr.write(
        f"\n[fatal] 当前 Python 缺少依赖：{e}\n\n"
        f"二选一：\n"
        f"  1) 用仓库自带虚拟环境（已装好）：{venv_python} demo.py\n"
        f"  2) 装进当前解释器后重跑：pip install -r requirements.txt && python demo.py\n\n"
    )
    sys.exit(1)

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "demo.db"
SEED_PATH = BASE_DIR / "seed" / "rules.json"
# M2-02（#17）：看板构建产物目录（dashboard/ npm run build 产出）；缺它只影响页面、不影响 API
DASHBOARD_DIST = BASE_DIR / "dashboard" / "dist"


def dashboard_state() -> str:
    """看板构建产物状态："ready"（dist 在场）| "missing"（需 npm run build）。"""
    return "ready" if DASHBOARD_DIST.is_dir() else "missing"


def mount_dashboard(app) -> None:
    """把看板静态托管挂到 ASGI app 上（demo 装配层专用，测试复用同一挂载参数）。

    /api/* 路由在 create_app 内已先注册，FastAPI 按注册顺序匹配：mount("/") 排在
    所有 API 路由之后，/api/* 永远命中 API 路由、不落进静态文件（冒烟有守卫断言）。
    dist 缺失时不挂静态、改给根路径一个构建指引页（非 404/白屏，#17 验收）。
    """
    if dashboard_state() == "ready":
        app.mount("/", StaticFiles(directory=DASHBOARD_DIST, html=True), name="dashboard")
        return
    from fastapi.responses import HTMLResponse

    guide = """<!doctype html><html lang="zh"><meta charset="utf-8">
<title>看板未构建</title>
<body style="background:#0b0e13;color:#eef2f8;font:14px/1.7 system-ui,sans-serif;
  display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
<div style="max-width:560px">
  <h2 style="margin:0 0 12px">看板构建产物缺失（dashboard/dist/ 不存在）</h2>
  <p style="color:#a9b4c4;margin:0 0 16px">API 与 SSE 正常。构建一次看板后重启本服务：</p>
  <pre style="background:#10141b;border:1px solid #202733;border-radius:8px;
    padding:12px 16px;color:#3ee7ff;margin:0">cd dashboard
npm install
npm run build</pre>
</div></body></html>"""

    @app.get("/", include_in_schema=False)
    async def _dashboard_build_guide() -> HTMLResponse:
        return HTMLResponse(guide)
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
        app = create_app(self.storage, self.engine, self.hub)
        # M2-02（#17）：看板静态托管挂在 demo 装配层——不进 create_app（测试装配保持纯净）
        mount_dashboard(app)
        return app


def run_demo_turn(deps: DemoDeps) -> str:
    """跑三拍全程（allow → 观察期 → block → 终止报告），返回 trace_id（可导入，供测试/复用）。"""
    run_start = time.time_ns()
    result = run_customer_service_turn(deps.sdk, deps.llm, DEMO_USER_MESSAGE)
    print()
    print_trace_tree(deps.base_url, result.trace_id)
    print()
    print(result.answer)
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
    if dashboard_state() == "missing":
        sys.stderr.write(
            "\n[warn] 看板构建产物缺失：dashboard/dist/ 不存在，浏览器打开根路径"
            "将看到构建指引页（非看板）。\n"
            "       构建一次即可（需 Node ≥20）：\n"
            "           cd dashboard && npm install && npm run build\n"
            "       之后重跑本脚本。API 与 SSE 不受影响，仍可 curl 验证。\n\n"
        )
    _start_server(deps)
    print("=" * 64)
    print("skill-observability M1 demo（客服场景 · 三拍全程：allow → 观察期 → 拦截）")
    print(f"  查询 API / SSE：{deps.base_url}  （实时流：curl -N {deps.base_url}/api/events）")
    dashboard_url = (
        f"{deps.base_url}/" if dashboard_state() == "ready" else "（dashboard/dist 缺失，根路径为构建指引页）"
    )
    print(f"  看板页面：{dashboard_url}")
    print("  生命周期：起服务 → 自动跑一遍 → 回车重跑（同进程，新 trace）/ Ctrl+C 退出")
    print("=" * 64)

    first = True
    while True:
        if first:
            first = False
        else:
            try:
                input("\n—— 回车重跑全程（同进程内：新 trace、DB 累积、SSE 续推）——")
            except (EOFError, KeyboardInterrupt):
                print("\n退出。")
                return
        run_demo_turn(deps)
        # 跑完不退出：提示语在下一轮循环的 input 里


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n退出。")
