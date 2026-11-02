# LLM 录制回放机制调研（issue #5）

> 调研问题：demo agent（自建 Python agent，使用 openai SDK 调 OpenAI 兼容 API）如何录制/回放 LLM 请求与响应，如何在真实 API 与回放间切换，断网/超额/模型不可用时如何靠回放稳定兜底。
> 结论服务于地图 Notes 已钉的技术底座决策：**真实 LLM API + 录制回放兜底**。

## 推荐方案（一句话）

**采用 VCR.py cassette 做 HTTP 传输层的录制/回放（`vcrpy>=9`，已原生支持 openai SDK 当前默认的 HTTPX2 客户端）：彩排时用 `record` 模式把演示脚本的全部 LLM 交互录成仓库内的 cassette 文件；演示默认 `live` 直连真实 API，捕获 `openai.APIError` 自动降级进入 `replay`（`record_mode="none"`）兜底；另有 `DEMO_LLM_MODE=replay` 全回放模式供断网彩排与现场无网预案。**

## 备选对比表

| 维度 | A. VCR.py cassette（推荐） | B. 自建 transport / `httpx2.MockTransport` handler | C. respx |
|---|---|---|---|
| 机制 | monkeypatch `httpx2.HTTPTransport.handle_request`，请求/响应序列化为 YAML cassette 文件 | 向 `OpenAI(http_client=httpx2.Client(transport=...))` 注入自写 transport，自己读写 JSON fixture | patch `httpx` / `httpcore` 模块 |
| 与当前 openai SDK 兼容 | ✅ 原生支持：vcrpy 的 httpx stub 明确按 `httpx`/`httpx2` 双实现 duck-typed；httpx2 支持 2026-06 合入（v8.2.0 起） | ✅ openai 官方迁移指南给出的 mock 方式就是 `httpx2.MockTransport` | ❌ respx 只 mock `httpx`/`httpcore`，仓库无任何 httpx2 代码；openai 迁移指南明言「只 patch legacy HTTPX 的 RESPX 拦截不了 SDK 默认客户端」，需等 HTTPX2 兼容版或 fork，或走 SDK 标注为 *temporary* 的 legacy httpx 逃逸舱（mypy 类型不过，需 `cast(Any, ...)`） |
| 录制能力 | ✅ 内置：`record_mode`（once/all/new_episodes/none）、`match_on` 匹配器（含 body）、`filter_headers`/`filter_sensitive_data` 脱敏、cassette 序列化 | ❌ 全自写（cassette 存取、请求匹配、脱敏、流式响应处理） | ❌ respx 本身不提供录制，只有 mock/断言 |
| 回放开关 | ✅ `record_mode="none"` + 上下文管理器，可按调用粒度开关，可运行中启用 | ✅ 每请求判断 mode flag，最细粒度、最透明 | ⚠️ 有 mock 开关，但录制与存储仍要自写 |
| 运行时兜底切换 | ✅ `with vcr.use_cassette(...)` 包裹失败后的重放即可（类级 patch，对已创建的 client 实例同样生效） | ✅ 天然支持（flag 置位后下一请求即回放） | 同 B |
| 依赖/工作量 | 单依赖 MIT 库，demo 侧约 30-50 行包装代码 | 零第三方依赖，但估计 200+ 行且要自己踩流式/重试/匹配的坑 | 需 pin 旧版 openai+httpx 或维护 fork，负资产 |
| 结论 | **推荐** | 备选：当需要更透明的逐请求控制、或 vcrpy 出问题时的退路 | 不推荐（当前与 SDK 默认客户端不兼容） |

补充：VCR.py 官方对 pytest 场景推荐 [pytest-recording](https://github.com/kiwicom/pytest-recording)（vcrpy 的 pytest 插件）；本项目是演示脚本而非测试套件，直接用 `vcr.use_cassette` 上下文即可，无需引入。

## 实现要点

### 录制时机

- **彩排阶段录制，不是开发时随手录**：演示脚本（固定 prompt 序列）定稿后，跑 `DEMO_LLM_MODE=record`（`record_mode="all"`）全量重录，保证 cassette 与当前脚本严格一致；脚本/prompt 一变就重录（vcrpy 惯例：删 cassette 即可重录，见 README）。
- 录制与回放必须使用**同一份演示脚本 + 同一 `max_retries` 设置**：openai SDK 默认对连接错误/408/409/429/5xx 自动重试 2 次，cassette 记录的是「每一次真实 HTTP 交互」（含失败重试），回放时 SDK 的重试逻辑照常在本地顺序消费交互，两边序列才对得上。
- 录制前确认 `OPENAI_API_KEY` 等敏感信息已配置好脱敏（见下），**cassette 要提交进 git 仓库**（现场兜底靠它）。

### cassette 存放

- 建议 `demo/cassettes/{场景}.yml`（客服、运维各一份），与「双演示场景 = 同一套运行时代码的两套配置」对齐：场景配置里带 cassette 路径，回放机制本身两场景共用同一段代码。
- 默认 YAML 格式即可（vcrpy 也支持 `serializer="json"`）；用 `cassette_library_dir` 指定目录。文件入库前跑一遍脱敏检查（API key、真实 token、真实 PII——演示数据虽是合成的）。

### 模式开关（与真实 API 的切换）

- 单一环境变量 `DEMO_LLM_MODE`，启动时读取，三档：

| 档位 | 行为 | 用途 |
|---|---|---|
| `live`（默认） | 不包 cassette 直连真实 API；捕获 `openai.APIError` → 日志告警 → 进入 `record_mode="none"` 的 cassette 重放同一请求 | 演示现场：真实 API 优先，失败自动兜底 |
| `replay` | 所有 LLM 调用都包在 `record_mode="none"` cassette 内，零网络 | 断网彩排、现场无网预案、CI 冒烟 |
| `record` | `record_mode="all"` 全量重录 cassette | 彩排时录制/更新 cassette |

- 代码骨架（demo 侧唯一需要写的包装）：

```python
import os, vcr, openai

MODE = os.getenv("DEMO_LLM_MODE", "live")          # live | record | replay
CASSETTE = "demo/cassettes/customer_service.yml"    # 由场景配置给出
MATCHERS = ("method", "scheme", "host", "port", "path", "query", "body")
VOPTS = dict(match_on=MATCHERS, filter_headers=("Authorization",))

def chat_completion(**kwargs):
    if MODE == "record":
        with vcr.use_cassette(CASSETTE, record_mode="all", **VOPTS):
            return client.chat.completions.create(**kwargs)
    if MODE == "replay":
        with vcr.use_cassette(CASSETTE, record_mode="none",
                              allow_playback_repeats=True, **VOPTS):
            return client.chat.completions.create(**kwargs)
    try:                                              # live：真实 API 优先
        return client.chat.completions.create(**kwargs)
    except openai.APIError as e:                      # 兜底：断网/429/404 等
        logger.warning("LLM API 不可用(%s)，降级回放: %s", type(e).__name__, e)
        with vcr.use_cassette(CASSETTE, record_mode="none",
                              allow_playback_repeats=True, **VOPTS):
            return client.chat.completions.create(**kwargs)
```

- **兜底触发条件直接复用 SDK 异常层级**（全部继承 `openai.APIError`）：断网/超时 → `APIConnectionError`/`APITimeoutError`；API 超额 → `RateLimitError`（429，SDK 默认已重试 2 次）；模型不可用 → `NotFoundError`（404）/`BadRequestError`（400）/`AuthenticationError`（401）等 `APIStatusError` 子类。demo 侧统一 `except openai.APIError` 一网打尽，日志里打具体子类名即可。

### 匹配与脱敏注意

- **必须把 `body` 加进 `match_on`**：chat completions 所有 prompt 打同一个 URL，vcrpy 默认 `match_on=("method","scheme","host","port","path","query")` 不含 body，不加会「串台」——不同 prompt 拿到同一条回放。同一代码路径序列化请求体是确定性的，body 匹配可靠。
- **脱敏在录制时做**：`filter_headers=("Authorization",)` 去掉 API key（默认匹配器不含 headers，去掉不影响回放匹配）；请求体里若有敏感值可用 vcrpy 9.2.0 的 `filter_sensitive_data`（录制时替换为占位符、加载时还原，匹配不受影响）。
- `allow_playback_repeats=True`：兜底或脚本重试导致同一请求重复发送时，允许重复播放同一条交互，避免抛 `CannotOverwriteExistingCassetteException`。
- vcrpy 是**进程级全局 patch**（patch transport 类方法）：演示进程内若有其他出站 HTTP（webhook 等）也会被录制/回放；用 `skip_patchers` 排除，或保证演示进程只有 LLM 一个出站。

## 与「真实 API + 回放兜底」（地图 Notes）的一致性

- 地图 Notes 技术底座原文「真实 LLM API + 录制回放兜底」与本方案逐字对应：`live` 档 = 真实 API 优先；`except openai.APIError → cassette 回放` = 兜底；`replay` 档 = 兜底能力的彩排/预案形态。
- 不引入新框架/导出管道，仅 +1 个 MIT 依赖（vcrpy），符合「自建 Python agent、单人 2-3 个月、最小依赖」的约束。
- 双演示场景共用同一套回放代码，只换 cassette 文件与场景配置，与「同一套运行时代码的两套配置」一致。
- 地图 Not yet specified 中「演示彩排与现场应急预案（回放模式细节依赖录制回放 research 结果）」由本票补齐口径，下游票「演示脚本与双场景配置定稿」可直接引用彩排流程：**脚本定稿 → `record` 录制 → `replay` 离线冒烟验收 → 现场 `live`（自动兜底）**。

## 依据（链接）

1. VCR.py 官方文档（record modes、matchers、cassette、pytest-recording 推荐）：https://vcrpy.readthedocs.io/en/latest/ 、https://vcrpy.readthedocs.io/en/latest/usage.html
2. VCR.py 兼容矩阵（含 `httpx`、`httpx2`；Python 3.11+）：https://vcrpy.readthedocs.io/en/latest/installation.html
3. VCR.py README（删 cassette 即重录；pytest 用 pytest-recording）：https://github.com/kevin1024/vcrpy
4. VCR.py 配置源码（默认 `match_on`、默认 `record_mode=once`、`filter_headers`、内置 matcher 含 `body`）：https://github.com/kevin1024/vcrpy/blob/master/vcr/config.py
5. VCR.py httpx/httpx2 stub 源码（双库 duck-typed；请求不在 cassette 且写保护时抛 `CannotOverwriteExistingCassetteException`，否则放行到真实服务器）：https://github.com/kevin1024/vcrpy/blob/master/vcr/stubs/httpx_stubs.py
6. VCR.py changelog（9.2.0 `filter_sensitive_data`、9.3.x `allow_playback_repeats` 录制期行为、9.4.0 为当前最新版）：https://github.com/kevin1024/vcrpy/blob/master/docs/changelog.rst ；httpx2 支持合入 commit（2026-06-09，v8.2.0 起可用）：https://github.com/kevin1024/vcrpy/commit/4a90c6840a
7. openai-python README（默认 HTTPX2 客户端、`http_client` 注入、错误层级 `APIError`/`APIConnectionError`/`APITimeoutError`/`RateLimitError` 429/`NotFoundError` 404、默认重试 2 次的条件）：https://github.com/openai/openai-python
8. openai-python HTTPX2 迁移指南（mock 必须拦截 HTTPX2；官方示例 `httpx2.Client(transport=httpx2.MockTransport(handler))`；RESPX 兼容性警告与 legacy httpx *temporary* 逃逸舱）：https://github.com/openai/openai-python/blob/main/httpx2.md
9. respx README（只 mock `httpx`/`httpcore`，要求 HTTPX 0.25+，无录制能力）：https://github.com/lundberg/respx ；其仓库检索 `httpx2` 无任何结果
10. HTTPX2（pydantic 接手维护、`httpx` 的延续、支持自定义 transport）：https://pydantic.dev/docs/httpx2/get-started/
11. pytest-recording（vcrpy 的 pytest 插件，备查）：https://github.com/kiwicom/pytest-recording

## 风险

1. **httpx2 支持较新**（2026-06 才合入）：必须 pin `vcrpy>=9`（当前 9.4.0），并在彩排时对「录制 → 回放 → 兜底」三条路径做全链路真机验证，尤其 `stream=True` 的 SSE 场景——vcrpy 录制时把响应体整体读入内存，回放一次性返回，SDK 解析正常但观感可能「秒出」，需彩排确认可接受。
2. **不加 `body` matcher 会串台**（默认匹配器不含 body），这是最容易埋到现场才爆的坑；实现时把 `match_on` 固化成常量并加单测断言。
3. **回放是「白名单」而非万能兜底**：`record_mode="none"` 下 cassette 未覆盖的请求直接抛异常——演示脚本 prompt 必须固定，脚本改了必须重录；彩排流程里要有「`replay` 模式离线跑通全部脚本」这一冒烟检查项。
4. **兜底本身也可能失败**（cassette 不全/未录）：兜底路径的 vcr 异常要再包一层 try/except，降级为向观众说明并重跑该拍——具体应急预案由下游彩排票落定。
5. **全局 patch 的副作用**：进程内其他出站 HTTP 会被一并录制/回放（见实现要点）；若 demo 服务端有额外出站，用 `skip_patchers` 隔离。
6. **脱敏必须在录制时完成**：cassette 入库即公开（对仓库可见者），`Authorization` 头与请求体中的敏感值一旦录进去就晚了；建议在 `record` 档强制 `filter_headers` 并在提交前人工过一遍 cassette。
