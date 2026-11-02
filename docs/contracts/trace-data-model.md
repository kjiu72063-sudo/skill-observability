# Trace 数据模型与查询 API 契约

> 对应 issue #6（wayfinder:grilling，Part of #1）。本文件是 **DDL 草案 + API 契约草案** 的定稿载体，下游票 #7（审计表）、#8（埋点 SDK）、#2（看板原型）直接引用。
> 依据：issue #4 调研结论（OTel 字段语义，仅字段）、issue #3 技术底座结论（FastAPI + SSE + SQLite）。**不引入 OTel collector / exporter 管道**（地图范围锁）。

## 1. 数据模型（SQLite DDL 草案）

### 1.1 核心决策

- **只有 span 表，不建 trace 冗余表**：trace 是查询时按 `trace_id` 的聚合视图（root span + 子查询），与 OTel「trace 是 span 的集合」语义同构，免去未完成 trace 的汇总维护。
- **span start 即落库**：`end_time_unix_nano` 允许 NULL（= 进行中），end 时 UPDATE 补时长与状态——满足看板「trace 树实时生长」。
- **列 / JSON 切分定稿**：高频查询维度成列（下表 12 个 OTel 列 + `agent_id`）；`gen_ai.*`、`error.type`、`skill_observability.*` 等全部进 `attributes` JSON，查询用 `json_extract`。**不再增设任何新列**（含 verdict）。
- **payload 快照不进 span**：归审计表（issue #7 定稿），span 只保留 verdict / 规则引用作展示。

### 1.2 span 表

```sql
CREATE TABLE span (
  trace_id             TEXT NOT NULL
                       CHECK (length(trace_id) = 32 AND trace_id NOT GLOB '*[^0-9a-f]*'),
  span_id              TEXT PRIMARY KEY
                       CHECK (length(span_id) = 16 AND span_id NOT GLOB '*[^0-9a-f]*'),
  parent_span_id       TEXT,                        -- NULL = 根 span
  name                 TEXT NOT NULL,               -- 低基数类别级，规则见 §3.3
  kind                 TEXT NOT NULL DEFAULT 'INTERNAL'
                       CHECK (kind IN ('INTERNAL','SERVER','CLIENT','PRODUCER','CONSUMER')),
  start_time_unix_nano INTEGER NOT NULL,
  end_time_unix_nano   INTEGER,                     -- NULL = 进行中
  status_code          TEXT NOT NULL DEFAULT 'UNSET'
                       CHECK (status_code IN ('UNSET','OK','ERROR')),
  status_message       TEXT,                        -- 仅 ERROR 时有值
  attributes           TEXT NOT NULL DEFAULT '{}',  -- JSON 对象
  events               TEXT NOT NULL DEFAULT '[]', -- JSON 数组
  agent_id             TEXT NOT NULL,               -- 本项目自定义列（≈ OTel Resource 拍平）
  CHECK (end_time_unix_nano IS NULL
         OR end_time_unix_nano >= start_time_unix_nano)
);
CREATE INDEX idx_span_trace       ON span (trace_id);
CREATE INDEX idx_span_agent_start ON span (agent_id, start_time_unix_nano);
```

约定：

- 主键 `span_id`（8 字节小写 hex，全局唯一）；`parent_span_id` **不建索引**（详情按 `trace_id` 一次取全量，前端建树用不到它）。
- 每 span 至多一个父；子 span 继承根的 `trace_id`（#4 结论）。
- 状态语义（#4 结论）：成功保持 `UNSET`、不写 `OK`；失败置 `ERROR` + `status_message` 放异常消息；**被策略拦截记 `ERROR`** + `attributes` 含 `error.type="policy.block"` 与 `skill_observability.verdict="block"`。
- `duration` 不落列：查询/展示时 = `end_time_unix_nano - start_time_unix_nano`；`end IS NULL` → 进行中（时长显示「进行中」，排序/计算需处理 NULL）。
- `kind` 实际只用 `INTERNAL`（根、Skill 调用）与 `CLIENT`（LLM 调用）；其余留枚举余量。
- 时间一律 Unix 纳秒 INTEGER（UTC），无时区歧义；API 原样返回，格式化由前端做。

### 1.3 event_log 表（SSE 回放源）

```sql
CREATE TABLE event_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,  -- 即 SSE 的 event id（Last-Event-ID 键）
  kind    TEXT NOT NULL CHECK (kind IN ('span.start','span.end')),
  ts      INTEGER NOT NULL,                   -- unix nano，调试/排序辅助
  payload TEXT NOT NULL                       -- 发出时的 JSON 快照，原样重放
);
```

- **存发出时快照、原样重放**：补发 `span.start` 时若从 span 表推导，读到的已是 end 后的状态，故不可从 span 表派生。
- 写入时机：span 落库（start）与 UPDATE（end）之后、SSE 广播之前，同事务或紧随其后。

## 2. 查询 API（REST）

统一前缀 `/api`；响应 JSON snake_case；时间字段一律 Unix 纳秒整数。

### 2.1 `GET /api/traces` — trace 列表

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `agent_id` | string | — | 精确匹配 root span 的 `agent_id` |
| `from` | int（unix nano） | — | root `start_time_unix_nano` ≥ from |
| `to` | int（unix nano） | — | root `start_time_unix_nano` ≤ to |
| `page` | int | 1 | 1-based |
| `page_size` | int | 20 | 1–100 |

- 以 **root span**（`parent_span_id IS NULL`）为行单位；`ORDER BY root.start_time_unix_nano DESC`；OFFSET 分页。
- 时间范围按 **root 的 start** 过滤（子 span 必在 root 窗口内）。

响应：

```json
{
  "items": [
    {
      "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
      "name": "invoke_agent customer-service",
      "agent_id": "customer-service",
      "start_time_unix_nano": 1765000000000000000,
      "end_time_unix_nano": null,
      "status_code": "UNSET",
      "span_count": 5,
      "blocked": true
    }
  ],
  "page": 1,
  "page_size": 20,
  "total": 137
}
```

- `span_count`：该 trace 的 span 总数（聚合子查询 `COUNT(*)`）。
- `blocked`：**仅展示字段，不是过滤参数**——任一 span 的 `json_extract(attributes,'$.skill_observability.verdict') = 'block'` 即 true，供行内徽标用。
- `status_code`：root span 自身状态。「查违规」诉求由审计区块（#7）承担。

### 2.2 `GET /api/traces/{trace_id}` — trace 详情

```json
{
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "spans": [
    {
      "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
      "span_id": "00f067aa0ba902b7",
      "parent_span_id": null,
      "name": "invoke_agent customer-service",
      "kind": "INTERNAL",
      "start_time_unix_nano": 1765000000000000000,
      "end_time_unix_nano": 1765000001500000000,
      "status_code": "UNSET",
      "status_message": null,
      "attributes": { "gen_ai.operation.name": "invoke_agent" },
      "events": [],
      "agent_id": "customer-service"
    }
  ]
}
```

- **平铺 spans 数组**（与 OTLP 同构、服务端不递归），`ORDER BY start_time_unix_nano ASC`；树形由前端按 `parent_span_id` 构建。
- span 对象字段 = 表列原样（含 `attributes` / `events` 已解析的 JSON，非字符串）。
- trace 不存在 → `404 {"detail": "trace not found"}`。

### 2.3 过滤参数的演进约定

`status` / `blocked` 过滤参数**不进本契约**；看板原型（#2）确认需要时再加，新增参数向后兼容，不改既有响应形状。

## 3. 实时推送（SSE 事件契约）

### 3.1 端点与传输

- `GET /api/events`，SSE（FastAPI `EventSourceResponse`），浏览器原生 `EventSource` 消费。
- wire 格式：`event:` 取 `span.start` / `span.end`；`id:` = `event_log.id`；`data:` = JSON 快照。
- `Last-Event-ID` 断线续传：按 `event_log.id > Last-Event-ID` 顺序重发**当时的 payload 快照**；首次连接（无 Last-Event-ID）从头全量回放，前端以 REST 初值 + SSE 回放合并。
- 空闲 keep-alive 注释由 `EventSourceResponse` 默认行为提供（约 15s）。

### 3.2 事件粒度与 payload

**分两个 event name**，React 按名监听；**start 最小、end 全量**（收到 end 即可直接渲染状态/时长/verdict，免二次请求与竞态）。

`span.start`（span 落库后立即推）——最小字段：

```json
{
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "span_id": "00f067aa0ba902b7",
  "parent_span_id": "b7ad6b7169203331",
  "name": "execute_tool query_user_db",
  "kind": "INTERNAL",
  "start_time_unix_nano": 1765000000100000000,
  "agent_id": "customer-service"
}
```

`span.end`（span UPDATE 后推）——**整行 span**（形状同 §2.2 的 span 对象，`end_time_unix_nano`、`status_code`、`attributes`、`events` 均已就位）。

### 3.3 span name 规则（沿用 #4）

- Skill 调用：`execute_tool {gen_ai.tool.name}`（如 `execute_tool query_user_db`）
- LLM 调用：`chat {gen_ai.request.model}`（如 `chat gpt-4o-mini`）
- 根 span：`invoke_agent {agent.name}`
- 实例级 ID 进 attributes 不进 name。

### 3.4 attributes 键约定（沿用 #4，本契约依赖的部分）

| 键 | 取值 / 说明 |
|---|---|
| `gen_ai.operation.name` | `chat` / `execute_tool` / `invoke_agent` |
| `gen_ai.tool.name`、`gen_ai.tool.call.id` | Skill 调用标识 |
| `gen_ai.request.model`、`gen_ai.provider.name`、`gen_ai.usage.*` | LLM span |
| `error.type` | 失败/被拦时设：异常类名 / `policy.block`；成功不设 |
| `exception.type/message/stacktrace` | 记在 `events` 里 `name="exception"` 的事件上 |
| `service.name` | = `agent_id`（保持 OTel 可读性） |
| `skill_observability.verdict` | `allow` / `block`（`blocked` 查询即 `json_extract` 此键） |
| `skill_observability.matched_rule` | block 时命中规则 id |
| `skill_observability.block_reason` | block 理由展示副本，权威副本在审计表 |

## 4. 与审计表的关联键（边界：其余归 #7）

- 审计记录携带 **`trace_id`（32 hex）+ `span_id`（16 hex）**，与 span 表同格式、指向该次 Skill 调用的 span。
- **纯逻辑引用，不建 SQLite FOREIGN KEY**（两表写入时序由 #7/#8 决定，SQLite 默认亦不开 FK 强制）。
- 本契约只钉键的格式与语义；审计表其余字段一字不碰。

## 5. 非目标（本票不覆盖）

- 审计表字段与规则 schema → #7；SDK 写路径与上报方式（进程内直连 vs 上报 API）→ #8；看板展示字段与交互 → #2。
- OTel collector / exporter / OTLP 传输、Resource/Scope 层、采样、W3C 传播 → 地图 Out of scope。
