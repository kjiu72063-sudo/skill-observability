# 策略引擎规则模型与审计契约

> 对应 issue #7（wayfinder:grilling，Part of #1）。本文件是**规则 schema + 管理 API + 审计表与查询契约**的定稿载体，下游票 #9（演示场景）、#10（M1 切片）、#2（看板原型）直接引用。
> 依据：issue #8 决议（`evaluate(tool_name, args, context) -> Verdict` 纯函数、SDK 拦截点统一写审计、进程内直连）、`docs/contracts/trace-data-model.md` §4（审计关联键 `(trace_id, span_id)`，无 FK）。
> 设计取舍见 `docs/adr/0001-rule-model-combination-primitives.md`。

## 1. 规则模型

### 1.1 规则字段

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `id` | string | POST 必填 | — | **客户端提供**的 slug：`^[a-z0-9][a-z0-9_-]{2,63}$`（如 `r1-pii-id-card`）；全局唯一，重复 → 409。理由：`matched_rule` 出现在 span attributes、审计表与演示文案里，须人类可读；种子与 API 同构 |
| `name` | string | 是 | — | 展示名（可中文） |
| `category` | enum | 是 | — | `pii` / `dangerous_command` / `tool_denylist` / `custom`；**仅展示与筛选，不参与求值** |
| `action` | enum | 是 | — | `block` / `audit`（观察期） |
| `enabled` | bool | 否 | `true` | `false` 时不参与求值 |
| `priority` | int | 否 | `100` | 小者先求值 |
| `agent_ids` | string[] \| null | 否 | `null` | 作用域；`null`/`[]` = 全局 |
| `tool_names` | string[] \| null | 否 | `null` | 匹配条件①；`null`/`[]` = 任意工具 |
| `args_regex` | object \| null | 否 | `null` | 匹配条件②，见 §1.2 |
| `description` | string \| null | 否 | `null` | 可选说明 |

校验：`tool_names` 与 `args_regex` **至少给一个**（两者全空 = 匹配一切，422 拒绝）。

### 1.2 匹配条件：两个原语，AND 组合

- **条件① 工具名集合**：`tool_name ∈ tool_names`（精确匹配）。
- **条件② 参数正则** `args_regex`：
  - `pattern`：必填，必须能 `re.compile`（否则 422）；
  - `flags`：可选，默认 `"i"`（不区分大小写，`RM -RF` 也拦）；只接受 `i`/`m`/`s` 的任意组合；
  - `fields`：可选 `string[]`；给出时只扫描 `args` **顶层同名 key** 下的值，缺省扫描全部。

匹配算法：递归遍历 `args` 收集**字符串叶子值**（dict 的 value、list 的元素；key 名与数字/布尔不参与），对每个叶子 `re.search(pattern, leaf, flags)`，任一叶子命中即条件②成立。序列化扫描文本上限 **64KB**，超出截断（防御性上限，演示数据远小于此）。

三类内置规则只是两个原语的组合 + `category` 标签：

| 内置类 | 条件① | 条件② |
|---|---|---|
| R1 PII | —（任意工具） | args_regex（身份证号/手机号等模式） |
| R2 危险命令 | `["run_shell"]` | args_regex（`rm -rf` 等），`fields: ["command"]` |
| R3 工具黑名单 | 黑名单列表 | — |

### 1.3 动作与裁决（evaluate 求值顺序）

动作两种：

- `block`：命中 → verdict = `block`，调用不执行（#8：`fn` 不运行，抛 `PolicyBlocked`）。
- `audit`（**观察期规则**）：命中**不拦**，verdict 仍为 `allow`，但命中事实写进审计记录与 span 标记（`skill_observability.matched_rule`）。用途：先观察、后收紧。

`evaluate(tool_name, args, context)` 求值顺序：

1. 过滤 `enabled=true` 且 `agent_ids` 命中 `context.agent_id` 的规则；
2. 按 `(priority asc, id asc)` 排序逐条求值；
3. 命中 `block` → **短路返回** `Verdict("block", rule_id, reason)`；
4. 循环结束无 block：取**最先**命中的 `audit` 规则 → `Verdict("allow", rule_id, reason)`；无任何命中 → `Verdict("allow", None, None)`。

Verdict 定稿（对齐 #8）：`Verdict(verdict: "allow"|"block", matched_rule: str|None, reason: str|None)`。

- `matched_rule` 存规则 **id**；`block` 时必非空，`allow` 时仅观察期命中非空。
- `reason` 为可直接上屏的中文理由：`命中规则 {id}（{name}）：{匹配片段}`；匹配片段为命中的叶子文本（纯工具名规则取工具名），截断至 80 字符。
- **不实现**：`allow` 动作短路（白名单压黑名单的二阶逻辑）；第三种 verdict（`warn`）。

### 1.4 作用域边界

- 作用域只有 **agent 维度**（`agent_ids`，null = 全局）。**无会话维度**：系统没有跨 trace 的会话实体（一次 agent 任务 = 一个 trace；多用户/多租户在地图 Out of scope）。若 #9 彩排确认客服演示需多轮对话，由 #9 引入 `session_id` 属性语义，不属于规则模型。
- 工具维度通过条件①表达，不是作用域。
- `context` 定稿为 `EvalContext(agent_id, trace_id, span_id)`：仅 `agent_id` 参与匹配，`trace_id`/`span_id` 留作理由文案与将来扩展。

### 1.5 能力边界（R4/R5 的表达）

引擎能力 = **调用前、无状态、基于单次调用入参的声明式匹配**，即 §1.2 两个原语的任意组合。凡能由此表达的规则类型都受支持，`category` 有 `custom` 兜底、不设枚举门槛。

以下能力**超出引擎边界，属「不支持」而非「支持但不演示」**：

- 输出侧/响应内容检测（引擎只见入参）；
- 调用频率/配额（需跨调用状态，违背纯函数）;
- 跨调用关联分析。

原票面提法「R4/R5 规则类型受支持但不进演示」按此修正：不存在被压制的内置类型，只有原语能力边界；R4/R5 仅作为 README「扩展点」的文档示例，**不进代码与种子数据**（假的扩展性展示经不起面试追问）。

### 1.6 种子数据

- 规则是**全局 DB 状态**（看板要管理它），**不进场景配置**；场景配置只含系统提示词/工具清单/预置数据（地图 Notes）。
- 启动时 `rule` 表为空 → 从 `seed/rules.json` 播种（幂等：非空即跳过）：

| id | category | action | agent_ids | 条件 | priority |
|---|---|---|---|---|---|
| `r1-pii-id-card` | pii | block | `["customer-service"]` | args_regex：18 位身份证号 `\d{17}[\dXx]` | 100 |
| `r1b-pii-phone-audit` | pii | **audit** | `["customer-service"]` | args_regex：手机号 `1[3-9]\d{9}` | 200 |
| `r2-dangerous-rm` | dangerous_command | block | `["ops"]` | `tool_names:["run_shell"]` + args_regex `rm\s+-[a-z]*[rf]`，`fields:["command"]` | 100 |
| `r3-tool-denylist` | tool_denylist | block | `["ops"]` | `tool_names:["drop_production_db"]` | 100 |

`r1b` 是观察期规则的活例（具体种子集可由 #9 彩排调整）。

## 2. 规则存储与热生效

```sql
CREATE TABLE rule (
  id            TEXT PRIMARY KEY,   -- 完整 slug 校验在 API 层（422），DDL 只做粗检
  name          TEXT NOT NULL,
  category      TEXT NOT NULL CHECK (category IN ('pii','dangerous_command','tool_denylist','custom')),
  action        TEXT NOT NULL CHECK (action IN ('block','audit')),
  enabled       INTEGER NOT NULL DEFAULT 1,
  priority      INTEGER NOT NULL DEFAULT 100,
  agent_ids     TEXT,               -- JSON 数组或 NULL
  tool_names    TEXT,               -- JSON 数组或 NULL
  args_regex    TEXT,               -- JSON 对象或 NULL
  description   TEXT,
  created_at_unix_nano  INTEGER NOT NULL,
  updated_at_unix_nano  INTEGER NOT NULL
);

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);  -- key='rules_version'，value=递增整数
```

热生效链路（单进程，同 #8「agent 与 FastAPI 同进程、共用实例」）：

1. API 写路径：**同事务**写 `rule` 表 + bump `meta.rules_version`；
2. 引擎持内存快照 + 已加载版本号；`evaluate()` 先比对内存版本，不一致才从库重载——正常求值路径**零 DB 读**，#8「引擎纯函数、不碰 DB」在"引擎不持连接"的意义上成立；
3. 语义：**API 返回 200 时，新规则已生效于下一次 `evaluate()`**；进行中的 span 与同一次 `execute_tool` 不受影响（一次调用只求值一次）。

非法正则在写路径被 422 拒绝——fail-safe 前移到写入时，运行时不会因规则问题求值失败。

## 3. 审计表与查询 API

### 3.1 audit 表

```sql
CREATE TABLE audit (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id              TEXT NOT NULL,   -- 32 hex，逻辑引用（trace 契约 §4，无 FK）
  span_id               TEXT NOT NULL,   -- 16 hex
  agent_id              TEXT NOT NULL,
  tool_name             TEXT NOT NULL,
  verdict               TEXT NOT NULL CHECK (verdict IN ('allow','block')),
  rule_id               TEXT,            -- 命中规则 id（含 audit 动作命中）；NULL = 未命中任何规则
  rule_name             TEXT,            -- 冗余快照：规则改名/删除后审计仍可读
  action                TEXT CHECK (action IN ('block','audit')),  -- 命中规则的动作
  reason                TEXT,
  payload               TEXT NOT NULL,   -- args JSON 快照（ensure_ascii=False）
  payload_truncated     INTEGER NOT NULL DEFAULT 0,
  created_at_unix_nano  INTEGER NOT NULL
);
CREATE INDEX idx_audit_created ON audit (created_at_unix_nano);
CREATE INDEX idx_audit_verdict ON audit (verdict, created_at_unix_nano);
CREATE INDEX idx_audit_trace   ON audit (trace_id);
CREATE INDEX idx_audit_rule    ON audit (rule_id);
```

- 写入者唯一：SDK 拦截点（#8 execute_tool 步骤④），每次 Skill 调用**无论 verdict** 都写一行。
- payload 上限 **8KB**，超出截断并置 `payload_truncated=1`。

### 3.2 `GET /api/audits`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `verdict` | `allow`/`block` | — | 精确匹配 |
| `agent_id` | string | — | 精确匹配 |
| `tool_name` | string | — | 精确匹配 |
| `rule_id` | string | — | 精确匹配 |
| `from` / `to` | int（unix nano） | — | `created_at_unix_nano` 范围 |
| `page` | int | 1 | 1-based |
| `page_size` | int | 20 | 1–100 |

响应（分页形状沿用 trace 契约 §2.1）：

```json
{
  "items": [
    {
      "id": 12,
      "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
      "span_id": "00f067aa0ba902b7",
      "agent_id": "customer-service",
      "tool_name": "query_user_db",
      "verdict": "block",
      "rule_id": "r1-pii-id-card",
      "rule_name": "客户身份证号外泄",
      "action": "block",
      "reason": "命中规则 r1-pii-id-card（客户身份证号外泄）：110101199003071234",
      "payload": {"query": "查一下 110101199003071234 的订单"},
      "payload_truncated": false,
      "created_at_unix_nano": 1765000000000000000
    }
  ],
  "page": 1,
  "page_size": 20,
  "total": 137
}
```

- `payload` 返回**已解析的 JSON 对象**（非字符串）；截断行返回截断后的对象。
- `ORDER BY created_at_unix_nano DESC, id DESC`；OFFSET 分页。
- **统计端点不在本契约**（口径挂 #2 原型确认，地图 fog）。

## 4. 管理 API（规则 CRUD）

统一前缀 `/api`；响应中的规则对象 = §1.1 全部字段（`agent_ids`/`tool_names`/`args_regex` 为已解析 JSON，`enabled` 布尔，`priority` 整数）+ `created_at_unix_nano` / `updated_at_unix_nano`。

| 方法 | 路径 | 成功 | 说明 |
|---|---|---|---|
| GET | `/api/rules` | 200 | `{"items": [...]}`，含 disabled，`ORDER BY priority, id`；**不分页**（规则量小） |
| POST | `/api/rules` | 201 | 建规则；`id` 重复 → 409 |
| PUT | `/api/rules/{id}` | 200 | **全量替换**；body.id 与路径 id 不一致 → 422；不存在 → 404；`enabled` 开关也是一次 PUT |
| DELETE | `/api/rules/{id}` | 204 | 硬删；不存在 → 404 |

- **不设 PATCH**。
- 错误 body 统一 `{"detail": "<一句话>"}`；校验失败（非法正则 / 枚举越界 / 两个匹配条件全空 / 字段类型错误）→ 422。
- **不加 `rule.changed` SSE 事件**：`event_log.kind` 的 CHECK 只有 `span.start/span.end`（trace 契约 §1.3），跨标签页规则同步非演示诉求；规则页变更后本地刷新。

## 5. 与既有决议的衔接（增量修订）

- `trace-data-model.md` §3.4 两个键的写入时机修订（本契约生效）：
  - `skill_observability.verdict`：block 必写；allow 仅**观察期命中**时写；未命中规则的成功调用不写（对齐 #8 步骤⑥「成功 UNSET」）。
  - `skill_observability.matched_rule`：block 必写；allow 且命中观察期规则时也写。
- 观察期命中的 span：`status_code` 保持 `UNSET`（非 ERROR），无 `error.type`。
- `block_reason` 语义不变：仅 block 时写。

## 6. 非目标（本票不覆盖）

- 统计端点与统计卡片口径 → #2；演示种子规则的具体内容与场景绑定 → #9；M1 切片范围 → #10。
- 输出侧检测、频率/配额、跨调用关联 → 引擎能力边界之外（§1.5）；ML/LLM 智能检测 → 地图 Out of scope。
