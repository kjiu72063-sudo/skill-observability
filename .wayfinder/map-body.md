## Destination

交付一个可现场演示的「Agent Skill 合规可观测平台」（skill-observability）：自建 Python agent（单一运行时，Skill 形态 = tool call）通过进程内埋点 SDK 上报全链路 trace 并接受内联策略拦截（allow/block + 理由，被拦调用不执行），无论 verdict 全量落审计日志；React 看板实时展示 trace 树、规则管理（API 动态增删改）、审计日志与统计。**Done = 四拍面试演示脚本通过**：①trace 树实时生长 ②违规调用被拦截 → agent 报告并终止子任务 → 审计日志含 verdict/命中规则/payload/trace 关联 ③看板四区块可操作 ④README 架构章节可讲「为什么这么设计」。

## Notes

- 领域：AI Agent 合规可观测；参照物 Langfuse/LangSmith 的 Trace 能力 + 策略引擎（规则拦截、审计日志）。单人开发，2-3 个月，验收标准 = 面试现场演示。工作语言中文。
- **硬护栏：原型先于开发。** M2 看板动工前必须过 `wayfinder:prototype`「看板信息架构低保真原型」的确认；没有原型确认不许写 React。
- **垂直切片。** M1（链路）/M2（看板）/M3（打磨）只是粗粒度阶段锚点，ticket 一律按垂直切片切；M1 的可见产出三选一定死（真实命令输出，或最小 trace 列表页），禁止出现「后端全好但没东西可点」的长窗口。
- **双演示场景 = 同一套运行时代码的两套配置**（系统提示词 + 工具清单 + 预置数据），不是两套 agent。客服场景触发 R1（PII），运维场景触发 R2（危险命令）/R3（工具黑名单）。
- **「兼容 OTel 语义」的含义**：数据模型沿用 OTel 字段约定（trace_id / span_id / parent / attributes），**不引入 OTel collector / exporter 管道**；调研票只许调研字段语义，不许搭导出管线。
- 技术底座（偏好已钉，research 票验证）：Python + FastAPI + SQLite；React + Vite；单命令本地启动；真实 LLM API + 录制回放兜底；进程内埋点 SDK；实时推送已裁定 SSE（见 Decisions so far）。
- 每个 session 按需调用 Skill：grilling + domain-modeling（原型票调 prototype）。决议落票后同步更新 CONTEXT.md 术语；满足「难逆转 + 无上下文会困惑 + 真实权衡」三条件才写 ADR。

## Decisions so far

<!-- 一行一张已关票：[票名](链接)：一句话结论 -->

- [技术底座验证：FastAPI+SSE+SQLite 单命令启动](https://github.com/kjiu72063-sudo/skill-observability/issues/3)：静态资源由 FastAPI 托管、SSE（原生 EventSourceResponse，弃 WebSocket）、stdlib sqlite3、`python server.py` 单命令；spike 全链路跑通（浏览器实时事件增长 + Last-Event-ID 续传），成果在 `research/stack-spike` 分支。
- [OTel span 字段语义调研（仅字段，不搭管道）](https://github.com/kjiu72063-sudo/skill-observability/issues/4)：11 个 OTel 原生字段 + 自定义 `agent_id`；attributes 沿用 `gen_ai.*` 约定，自定义仅 `skill_observability.verdict/.matched_rule/.block_reason`；block 记 ERROR + `error.type="policy.block"`；payload 快照不进 span 归审计表；成果在 `research/otel-span-fields` 分支。
- [LLM 录制回放机制调研](https://github.com/kjiu72063-sudo/skill-observability/issues/5)：推荐 VCR.py cassette（httpx2 拦截），三档开关 `live/replay/record` + `except openai.APIError` 自动降级兜底；`match_on` 必须含 body，cassette 按场景分文件并脱敏；respx 不可用；成果在 `research/llm-replay` 分支。
- [Trace 数据模型与查询 API 契约](https://github.com/kjiu72063-sudo/skill-observability/issues/6)：只存 span 表（trace=查询聚合视图，`end_time_unix_nano` NULL=进行中，attributes 不加列）；`GET /api/traces`（agent_id/时间/page）+ 详情平铺数组前端建树；SSE 分 `span.start`/`span.end` 两事件、event_log 快照按 Last-Event-ID 回放；审计关联键 `trace_id`+`span_id` 无 FK；契约文件 `docs/contracts/trace-data-model.md`。
- [埋点 SDK 接口与内联拦截点设计](https://github.com/kjiu72063-sudo/skill-observability/issues/8)：分层 API（上下文管理器原语 agent_run/chat + 唯一派发入口 execute_tool，拦截点不可绕过）；contextvars 传父子；block 抛 PolicyBlocked（matched_rule/reason/trace_id/span_id）子任务边界终止；进程内直连写库+同进程直推 SSE、不设上报 API；审计由 SDK 拦截点统一写、引擎纯函数 evaluate()。
- [策略引擎规则模型与管理 API](https://github.com/kjiu72063-sudo/skill-observability/issues/7)：匹配条件=工具名集合+参数正则两原语 AND（category 仅展示不参与求值）；动作 block/audit，audit=观察期（命中不拦、verdict 仍 allow、matched_rule 有值）；作用域仅 agent 维度（无会话）；热生效=rule 表唯一真相+内存快照+rules_version，API 200 后下一次 evaluate 生效；审计表字段、GET /api/audits、规则 CRUD（id 客户端 slug、PUT 全量替换、无 PATCH、不加 rule.changed SSE）均入契约；R4/R5 修正为引擎能力边界（不支持≠不演示），种子 R1/R2/R3+观察期活例；契约 docs/contracts/policy-and-audit.md（0b480cd）+ ADR-0001。

## Not yet specified

- 看板视觉设计与组件选型细节（原型确认后再定）。
- 统计卡片的具体口径与数量（四拍只承诺「若干统计卡」）。
- 测试策略与 CI 形态（演示项目，最小集待定）。
- README 架构章节的叙事结构。

## Out of scope

- MCP 适配器、Claude Code/SKILL.md hooks、LangChain 等现有框架接入——README 提名为「下一步适配器」，本图不建票。
- 生产级部署（容器化 / K8s / 高可用 / 水平扩展）。
- 登录、多用户、多租户（agent 身份用配置内 agent_id 区分）。
- ML/LLM 智能违规检测（规则只走声明式匹配：正则/列表/上下文条件）。
- 告警通知与 BI 分析（邮件/Webhook/周报/趋势预测；看板只展示当下与近 7 天）。



