# OTel span 字段语义调研（仅字段，不搭管道）

> 对应 issue #4（wayfinder:research）。范围锁：只调研字段与语义约定，**不引入 OTel collector / SDK / exporter 管道**。
> 项目背景：自建 Python agent + 进程内埋点 SDK + SQLite 存储，需要「沿用 OTel 字段命名但自己实现」的 span schema。
> 下游「Trace 数据模型与查询 API 契约」（issue #6）直接引用本文的字段清单。

## 结论

### 一、关键语义结论

1. **ID 与父子关系**
   - `trace_id`：16 字节、32 位小写 hex、至少一个非零字节；每个根 span 新建一个 trace_id，子 span 必须继承父的 trace_id。
   - `span_id`：8 字节、16 位小写 hex、至少一个非零字节，span 创建时分配。
   - 每个 span **最多一个父 span**（0 或 1）；无父 = 根 span；`parent_span_id` 为空即根。树形嵌套即 trace。
   - 本项目单进程内埋点，不涉及 remote parent / W3C 传播（见「明确不引入」）。

2. **status 语义**
   - 三值枚举 `UNSET`（默认）/ `OK` / `ERROR`，全序 `OK > ERROR > UNSET`；`status.message`（规范里叫 Description）**只允许配 `ERROR`**，对 OK/UNSET 必须忽略。
   - 埋点库默认保持 `UNSET`；**成功不要写 `OK`**（规范明确：instrumentation SHOULD NOT set Ok，除非显式配置）。
   - 失败时：置 `ERROR` + 写 `error.type` 属性（低基数、可预期；成功时不得设置；未知错误用 `_OTHER`）+ `status.message` 放异常消息（不得在 message 里重复 error.type）。
   - 被重试或已优雅处理的错误**不应**记为 span error。
   - **异常事件**：事件名 MUST 为 `exception`，属性 `exception.type` / `exception.message` / `exception.stacktrace`（`exception.escaped` 已废弃）。
   - **本项目 block 的定性**：策略拦截从 agent 视角是「调用被拒绝、子任务终止」，推荐记 `status=ERROR` + `error.type="policy.block"` + 自定义属性 `skill_observability.verdict="block"`——trace 树上显示为红叉（演示需要），且可用 error.type / verdict 与技术故障区分。（备选：status 保持 `UNSET`、只靠 verdict 属性标记；代价是看板上拦截与正常调用无颜色差异。）

3. **SpanKind 语义**
   - `CLIENT`：向远端发起请求并等待响应；`SERVER`：处理入站远端请求；`PRODUCER`/`CONSUMER`：消息异步生产/消费；`INTERNAL`：应用内部操作（默认值）。
   - **本项目取值**：
     - LLM API 调用 span → `CLIENT`（GenAI 推理 span 规范：SHOULD be CLIENT）。
     - Skill（tool call）span → `INTERNAL`（GenAI execute_tool 规范：SHOULD be INTERNAL——工具由应用代码直接执行，不是远端调用）。
     - 根 span（一次 agent 任务）→ `INTERNAL`。
     - 若某 skill 内部发起真实 HTTP/远端调用，该**内层** span 才用 `CLIENT`（对应远端若被观测则为 `SERVER`；RPC 规范对 client/server 是 MUST）。

4. **span name 规则**
   - name 是「统计上有趣的一类 span」的最通用标识，**泛化优先于可读性**；实例级 ID 放 attributes 不放 name（`get_account` 好，`get_account/42` 差）。
   - Skill 调用：`execute_tool {gen_ai.tool.name}`（如 `execute_tool query_user_db`）。
   - LLM 调用：`{gen_ai.operation.name} {gen_ai.request.model}`（如 `chat gpt-4o-mini`）。
   - 根 span：沿用 GenAI agent 惯例 `invoke_agent {gen_ai.agent.name}`（Development 稳定性，可降级为固定 `invoke_agent`）。
   - 参考 RPC 惯例（issue 点名）：span name SHOULD 为 `{rpc.method}`，不可用时 `{rpc.system.name}`；client MUST `CLIENT`、server MUST `SERVER`；`error.type` 仅失败时必设。

5. **attributes 命名惯例**
   - 点号分命名空间、全小写、首段即命名空间（`service.version` 中 `service` 是命名空间）、段内多词用下划线；`otel.*` 前缀被规范保留。
   - 非标准属性：**推荐用本应用名作前缀**（规范原文：prefix the attribute name by your application name），且不推荐蹭 OTel 已有语义约定命名空间——故本项目自定义属性用 `skill_observability.*`。
   - key 必须非空、大小写敏感、同一 span 内唯一、同 key 覆盖旧值。
   - 值类型仅限：string / bool / double / int64、同质基本类型数组、byte 数组、`map<string, AnyValue>`。
   - 稳定性分层：span 基础字段与 `error.type`、`exception.*` 为 **Stable**；`gen_ai.*` 为 **Development**（GenAI 语义约定已迁至独立仓库）；RPC 语义约定为 **Release Candidate**。自设计 schema 可放心对齐 Stable 部分，gen_ai 部分视为「命名建议」。

### 二、推荐 span 字段清单（SQLite span 表列）

存储列名沿用 OTLP protobuf 的 snake_case 字段名（与 OTLP/JSON 的 lowerCamelCase 如 `traceId` 语义一一对应，未来如需对接 OTLP 仅是改名）。

| 字段名 | 含义 | 是否 OTel 原生命名 |
|---|---|---|
| `trace_id` | 32 位小写 hex；同一 trace 全体 span 相同；根 span 新建 | 是（`trace_id`） |
| `span_id` | 16 位小写 hex；span 创建时分配 | 是（`span_id`） |
| `parent_span_id` | 父 span 的 span_id；根 span 为 NULL | 是（`parent_span_id`） |
| `name` | span 名称，低基数类别级（规则见上） | 是（`name`） |
| `kind` | `INTERNAL` / `SERVER` / `CLIENT` / `PRODUCER` / `CONSUMER`（本项目实际只用前 3 个） | 是（`kind` / SpanKind） |
| `start_time_unix_nano` | 开始时间，Unix 纳秒（INTEGER） | 是（`start_time_unix_nano`） |
| `end_time_unix_nano` | 结束时间，Unix 纳秒，>= start；duration 查询时计算不落列 | 是（`end_time_unix_nano`） |
| `status_code` | `UNSET` / `OK` / `ERROR`（对应 OTLP 枚举 0/1/2；存 TEXT 便于查询，语义对齐） | 是（`status.code`） |
| `status_message` | 仅 `ERROR` 时有值：异常消息或 block 理由 | 是（`status.message`，规范中称 Description） |
| `attributes` | JSON 对象：属性键值（键唯一、同键覆盖）；value 类型见上 | 是（`attributes`） |
| `events` | JSON 数组：`{name, time_unix_nano, attributes}`；异常事件 `name="exception"` | 是（`events` / Span Event） |
| `agent_id` | 配置内 agent 身份（客服/运维两套配置的区分键，查询过滤用） | **否（本项目自定义列）**——语义上近似 OTel Resource 的 `service.name`；同时建议在 `attributes` 里写一份 `service.name` 以保持 OTel 可读性 |

（`dropped_attributes_count` / `dropped_events_count` / `links` / `trace_state` / `flags` 不入表，理由见「明确不引入」。）

### 三、推荐 attributes 键清单

| 键 | 含义 / 取值 | 是否 OTel 原生命名 | 稳定性 |
|---|---|---|---|
| `gen_ai.operation.name` | `chat`（LLM 调用）/ `execute_tool`（Skill 调用）/ `invoke_agent`（根） | 是（GenAI 语义约定） | Development |
| `gen_ai.request.model` | LLM 请求模型名，如 `gpt-4o-mini` | 是 | Development |
| `gen_ai.provider.name` | 提供方，如 `openai` | 是 | Development |
| `gen_ai.tool.name` | Skill/工具名（execute_tool span 的 Required 属性） | 是 | Development |
| `gen_ai.tool.call.id` | 模型侧给出的工具调用 id（如有） | 是 | Development |
| `gen_ai.conversation.id` | 会话/线程关联 id（trace 按会话聚合用） | 是 | Development |
| `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` | token 用量（LLM span） | 是 | Development |
| `error.type` | 失败时必设：异常类名 / HTTP 状态码 / `policy.block`；成功不设 | 是 | **Stable** |
| `exception.type` / `exception.message` / `exception.stacktrace` | 记在 `name="exception"` 的事件上 | 是 | **Stable** |
| `service.name` | 建议 = `agent_id`（保持对 OTel 工具的可读性） | 是（本应属 Resource，单表存储拍平进 attributes） | Stable |
| `skill_observability.verdict` | `allow` / `block`——策略引擎裁决，trace 树着色与筛选用 | **否（本项目自定义）** | 本项目私有 |
| `skill_observability.matched_rule` | verdict=block 时命中的规则 id/名 | **否（本项目自定义）** | 本项目私有 |
| `skill_observability.block_reason` | block 理由（与审计记录同源；span 上仅作展示，权威副本在审计表） | **否（本项目自定义）** | 本项目私有 |

说明：

- **payload 快照不进 span attributes**：GenAI 的 `gen_ai.tool.call.arguments` / `gen_ai.tool.call.result` 是 Opt-In 且可能含敏感数据；本项目 payload 归审计表（issue #7 范围），span 只保留 verdict / 规则引用。
- span 表按列查询的高频维度（trace_id、parent_span_id、agent_id、kind、status_code、时间）用列；低频/稀疏信息（模型名、token 数、verdict 细节）进 `attributes` JSON——列 vs JSON 的最终切分由下游契约票定稿。

## 依据（链接）

以下均为本次实际抓取的权威来源：

1. **Trace API 规范（ID 格式、父子关系、SpanKind、status、span name、attributes、events）**
   - https://opentelemetry.io/docs/specs/otel/trace/api/
   - https://github.com/open-telemetry/opentelemetry-specification/blob/main/specification/trace/api.md （Set Status / SpanKind / Span Creation 原文）
2. **attributes 命名惯例（命名空间、小写、`otel.*` 保留、应用名前缀）**
   - https://opentelemetry.io/docs/specs/semconv/general/naming/
3. **attributes 值类型与 key 规则**
   - https://opentelemetry.io/docs/specs/otel/common/
4. **错误记录规则（何时置 ERROR、error.type、status message、被处理错误不记）**
   - https://opentelemetry.io/docs/specs/semconv/general/recording-errors/
   - 原文：https://github.com/open-telemetry/semantic-conventions/blob/main/docs/general/recording-errors.md
5. **RPC span 语义（span name = rpc.method、client/server MUST CLIENT/SERVER、error.type 条件必设）**
   - https://opentelemetry.io/docs/specs/semconv/rpc/rpc-spans/
6. **异常事件（事件名 MUST `exception`、属性、escaped 废弃）**
   - https://opentelemetry.io/docs/specs/semconv/exceptions/exceptions-spans/
   - 迁移方向（logs 信号）：https://github.com/open-telemetry/semantic-conventions/blob/main/docs/exceptions/exceptions-logs.md
7. **`error.type` 属性定义（低基数、成功不设、`_OTHER`）**
   - https://opentelemetry.io/docs/specs/semconv/registry/attributes/error/
8. **GenAI tool/skill span（execute_tool：name、INTERNAL kind、属性表）**
   - https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md
   - LLM 推理 span：https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/client-inference.md
   - agent/Agent Skills 细化（`invoke_agent`、`gen_ai.skill.name`）：https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md
   - `gen_ai.*` 属性注册表：https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/
9. **OTLP span 字段名与类型（trace.proto：trace_id/parent_span_id/start_time_unix_nano/Status 枚举）**
   - https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/trace/v1/trace.proto
   - OTLP/JSON 键名为 lowerCamelCase（`traceId`）：https://opentelemetry.io/docs/specs/otlp/

## 本项目自定义字段（OTel 无对应原生命名）

| 字段/键 | 位置 | 理由 |
|---|---|---|
| `agent_id` | span 表列 | 地图要求按 agent_id 过滤（issue #6）；OTel 对应概念是 Resource，本项目不建 Resource 层，故拍平为列；同时在 attributes 写 `service.name` 保持 OTel 可读性 |
| `skill_observability.verdict` | attributes | 策略引擎裁决 allow/block 是本平台核心领域概念，OTel 无对应；命名遵循「应用名前缀」规则 |
| `skill_observability.matched_rule` | attributes | block 时命中规则，供 trace 树即时展示（权威记录在审计表） |
| `skill_observability.block_reason` | attributes | 同上，展示用副本 |

（span 主体字段全部沿用 OTel 命名——本清单中只有上表 4 项是自定义。）

## 明确不引入的部分（collector / exporter 等，out of scope）

- **OTel collector、OTLP exporter、OTel SDK（opentelemetry-python）、自动埋点**——地图范围锁，本票及后续票均不搭建；自建进程内 SDK 只「借用字段语义」。
- **OTLP 传输协议 / 导出管道 / schema_url**——无导出需求，SQLite 即存储终点。
- **Resource、InstrumentationScope 两级结构**——单表存储拍平：agent 身份进 `agent_id` 列，scope 概念（SDK 名/版本）暂不需要。
- **`trace_state` / `flags` / W3C traceparent 传播 / remote parent**——单进程 agent，无跨进程上下文传播。
- **Span `links`**——本项目无「跨 trace 批处理引用」场景。
- **`dropped_*_count` 系列**——自有存储不设 OTel SDK 那类属性/事件上限，无需此计数。
- **采样（sampler / sampling）**——全量落库（审计要求「无论 verdict 全量写入」），不采样。
- **OTel metrics / logs 信号**——本平台只做 trace + 自有审计表。
