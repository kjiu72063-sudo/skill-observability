# 技术底座 spike：FastAPI + SSE + SQLite 单命令启动

关联 issue #3（wayfinder:research）。范围锁：无 OTel collector/exporter、无 Docker。
环境：Python 3.13.9 / Node v24.18.0 / npm 11.16.0 / FastAPI 0.162.0（2026-10-23 发版）。

## 结论（每项选型一句话）

1. **静态资源由 FastAPI 托管**（`app.frontend("/", directory="dist", fallback="index.html")`，内部即 StaticFiles）：演示时 API + 页面 + SSE 只起一个进程、一条命令；Vite dev server 仅作开发期可选辅助，不进演示路径。
2. **实时推送用 SSE，不用 WebSocket**：FastAPI ≥0.135 原生 `fastapi.sse.EventSourceResponse`，浏览器/React 用原生 `EventSource`（useEffect 即可、零第三方库），自带自动重连与 `Last-Event-ID` 断点补发；看板是服务端单向推 trace 事件，用不到 WebSocket 的双向能力。
3. **存储用 SQLite（stdlib `sqlite3`）**：单文件库、零服务进程，与「单命令启动」天然契合，同时充当 SSE 断线回放的数据源。
4. **单命令启动 = `python server.py`**：前端一次性 `npm run build` 产出 `dist/` 后，uvicorn 一个进程托管全部；对比 Vite dev 方案（`vite` + `uvicorn` 双进程 + `server.proxy`/`ws:true` 代理配置）少一种故障面。
5. **spike 已跑通**：服务起得来、事件推得到、页面收得到（真实浏览器实测，React 页 5 秒内 433 → 436 条实时增长）。

## 依据（一手文档链接）

- FastAPI — Server-Sent Events tutorial：https://fastapi.tiangolo.com/tutorial/server-sent-events/
  0.135.0 起原生 `EventSourceResponse` / `ServerSentEvent`；yield 即按 wire 格式编码；空闲时每 15s 发 keep-alive 注释；自动带 `Cache-Control: no-cache` 与 `X-Accel-Buffering: no`（防反代缓冲）；给出 `Last-Event-ID` 续传示例。
- FastAPI — Static Files：https://fastapi.tiangolo.com/tutorial/static-files/
  `StaticFiles` 挂载方式；文档明确「host a frontend 用 `app.frontend()`」。
- FastAPI — Frontend：https://fastapi.tiangolo.com/tutorial/frontend/
  `app.frontend("/", directory="dist", fallback="index.html")` 提供 SPA fallback（仅对 GET/HEAD + `Accept: text/html` 生效，缺资源仍 404）；**API 路由优先于静态文件**；`FASTAPI_ENV=development` 时 dist 缺失仅警告（可先起后端再构建）。
- FastAPI — WebSockets（advanced）：https://fastapi.tiangolo.com/advanced/websockets/
  需额外 `uv add websockets`；多客户端广播要手写 ConnectionManager；内存广播「只在单进程内有效」，生产要接 broadcaster/Redis——演示项目里这些都是纯成本。
- Vite — server.proxy：https://vite.dev/config/server-options.html
  dev 模式要把 `/api` 代理到 `http://localhost:8000`；WebSocket 代理需 `ws: true`；Vite 不校验被代理 WS 的 Origin（需后端自己校验）。
- MDN — EventSource：https://developer.mozilla.org/en-US/docs/Web/API/EventSource
  严格单向 server→client；Baseline 广泛可用（2020-01 起）；**HTTP/1.1 下同域最多 6 条 SSE 连接**（Chrome/Firefox 标注 won't fix），HTTP/2 下无此限制。
- MDN — Using server-sent events：https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events
  断线自动重连、`retry:` 控制重连间隔、`id:` → 浏览器重连时自动带 `Last-Event-ID`；「客户端代码与 WebSocket 几乎一致」。
- PyPI fastapi：https://pypi.org/project/fastapi/ （0.162.0，2026-10-23）

**二选一依据**：FastAPI 托管 = 单进程单命令、同源无 CORS/代理、演示故障面最小；Vite dev server = 双进程编排 + 代理配置，只换来开发期 HMR。本项目交付形态是「面试现场一条命令起服务」，故钉死 FastAPI 托管，开发期想用 HMR 时临时起 `npm run dev` 即可（proxy 配置已写在 `vite.config.js`），但不作为演示路径。

## spike 证据（实际跑通的命令与输出摘要）

代码：`spike/server.py`（FastAPI + SQLite + SSE + 静态托管）、`spike/static/index.html`（原生 EventSource 演示页）、`spike/frontend/`（React + Vite 最小实现）、`spike/requirements.txt`。

### 1. 安装与单命令启动

```bash
cd spike && python -m venv .venv
.venv/Scripts/pip install -r requirements.txt
# → fastapi 0.162.0; fastapi.sse OK; app.frontend: True

python server.py
# → stack-spike 已启动: http://127.0.0.1:8000/  (Ctrl+C 退出)
```

### 2. 服务起得来

```bash
curl http://127.0.0.1:8000/api/health
# → {"ok":true,"events":121}
```

### 3. 事件推得到（curl 直连 SSE）

```bash
curl -sN --max-time 5 http://127.0.0.1:8000/api/events > out.txt
# 5 秒收到 15577 字节，wire 格式：
#   event: trace
#   data: {"id": 1, "kind": "verdict", "payload": {"tool": "send_email", "verdict": "allow"}}
#   id: 1
# 先回放 SQLite 历史 #1..#121，随后实时收到 #122 #123 #124（演示事件源每 1.5s 一条）

curl -sN --max-time 3 -H "Last-Event-ID: 121" http://127.0.0.1:8000/api/events
# → 从 #122 续传，断线补发正确
```

### 4. 页面收得到（真实浏览器，DOM 实测）

- **原生页**（FastAPI 托管 `static/index.html`）：状态 `connected (SSE)`，列表渲染 #1..#169；5 秒后 196 → 199（grew=true）。
- **React 页**（Vite 构建产物由 FastAPI 托管）：

```bash
cd frontend && npm install && npm run build
# → added 66 packages in 2m；vite v6.4.5 ✓ built in 680ms
# → dist/index.html 0.34 kB + dist/assets/index-7weMErtP.js 144.58 kB

curl -s http://127.0.0.1:8000/ | head -3        # → Vite 产物 index.html（title: stack-spike · React+SSE）
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8000/assets/index-7weMErtP.js   # → 200
```

浏览器打开 `http://127.0.0.1:8000/`：`h1 = "skill-observability · stack-spike (React + Vite)"`，状态 `connected (SSE)`，5 秒内 **433 → 436** 条（grew=true）——回放 + 实时链路在 React 页上全部成立。

### 5. React 侧消费成本（全部 SSE 代码）

```jsx
useEffect(() => {
  const es = new EventSource("/api/events");
  es.onopen = () => setStatus("connected (SSE)");
  es.onerror = () => setStatus("disconnected (自动重连中)");
  es.addEventListener("trace", (e) => setEvents(v => [...v, JSON.parse(e.data)]));
  return () => es.close();
}, []);
```

零第三方库；上行操作（查询、规则增删改）走普通 REST，互不干扰。

## 风险与坑

1. **`EventSourceResponse` 的编码在 FastAPI 路由层**：必须 `response_class=EventSourceResponse` + 在路径函数内 `yield`；若自行 `return EventSourceResponse(gen())`，会抛 `'ServerSentEvent' object has no attribute 'encode'`（本 spike 实测踩坑，已修正）。
2. **版本门槛**：`fastapi.sse` 要 FastAPI ≥0.135.0，`app.frontend()` 也是新 API（本机全局 0.115.2 都没有）；`requirements.txt` 必须钉 `fastapi>=0.135`，spike 实测 0.162.0。
3. **SSE 单向**：`EventSource` 不能自定义请求头（除浏览器自动带的 `Last-Event-ID`），鉴权只能用 cookie 或 query 参数；看板上行一律走 REST POST/PUT。
4. **HTTP/1.1 同域 6 连接上限**：非 HTTP/2 时每浏览器同域最多 6 条 SSE 流（Chrome/Firefox won't fix）；单用户演示只挂 1 条无碍，但别开一堆标签页各挂一条。
5. **回放与实时的竞态**：回放时每次 `yield` 都会让出事件循环，未先订阅会漏掉此间到达的实时事件；spike 用「先订阅 → 回放 → 按 id 去重」解决（见 `server.py` 注释）。
6. **断线补发必须做**：浏览器断线后自动重连并带 `Last-Event-ID`，服务端按 id 补发历史，否则刷新页面会出现事件缺口（spike 已实现）。
7. **生成器必须有 `await` 点**：否则客户端断开时任务无法取消（FastAPI 文档明确提醒）；spike 用 `await queue.get()`，天然满足。
8. **`@app.on_event("startup")` 已弃用**：会打 DeprecationWarning，应改用 `lifespan`（spike 已改）。
9. **Vite dev 方案的隐藏成本**（开发期若启用）：`server.proxy` 指 `/api` 到 8000、WS 还要 `ws: true`、双进程谁先谁后、端口占用——都进了演示故障面，故只作开发辅助。
10. **SQLite 并发**：stdlib sqlite3 单连接同步写在 asyncio 单线程内串行，演示量级（1.5s/条）绰绰有余；事件高频化再开 WAL 或落库队列。
