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
- [M1 垂直切片验收物定死](https://github.com/kjiu72063-sudo/skill-observability/issues/10)：可见产出 = A 真实命令输出（`python demo.py` 单命令、LLM replay 档、打印走查询 API 不直读 DB，不碰 React，与 #2 并行）；垂直范围 = allow / 观察期 / block 三条端到端路径全通到「可查询」（进：chat 原语、引擎全语义、查询 API×3、SSE 推送；不进：规则 CRUD+热生效→M2 规则管理区块）；验收 = 人验 5 项 + pytest 冒烟机验 4 项（详见 #10 决议）；M2 原则「一区块一片端到端」（树→审计→规则管理→统计）、M3 原则「以四拍倒排每片收口一拍」；实现票 [M1 垂直切片实现](https://github.com/kjiu72063-sudo/skill-observability/issues/11)。
- [M1 子票1：曳光弹——allow 路径端到端 + demo 生命周期定型](https://github.com/kjiu72063-sudo/skill-observability/issues/12)：`python demo.py` 单命令全链落地（SDK 三原语按 #8 八步/被拦七步、引擎全语义+种子 4 条、查询 API×3 + SSE 回放/实时/续传、replay 档手写 cassette、生命周期=自动首跑→回车同进程重跑→Ctrl+C）；code-review 两轴两缺陷（观察期 span 标记漏写、审计 payload 截断）TDD 红→绿修掉；人验+新会话复查双过（1717480 / cbf328c / f440b24）。
- [M1 子票2：观察期与拦截两拍打通](https://github.com/kjiu72063-sudo/skill-observability/issues/13)：三拍全程落地——观察期（r1b 命中不拦 verdict=allow）+ 拦截（r1 短路、fn 不执行、PolicyBlocked 子任务边界捕获、终止报告）+ 审计恰三行×重跑不翻倍；root 终态 UNSET（拦截语义由工具 span ERROR 承载）；f440b24 观察期标记端到端首验为真；缺陷 7999fbf（db.py json_extract 含点键需引号路径）裁定条款行使合规；评审两拍过（Spec 0 finding、唯一软违规 8db0f2d 修掉）+ 用户亲手 QA 过（9c45942/7999fbf/8db0f2d）。
- [M1 子票3：冒烟机验与 #11 收口](https://github.com/kjiu72063-sudo/skill-observability/issues/14)：机验 4 项落地 13 条全绿（断言逐条对应 #10 机验 6–9；进程内装配+TestClient+直调场景入口，不走交互循环）；变异抽查 5 处全被抓，#12/#13 三条被修路径全有具名回归；评审两拍（主 finding 截断回归 e536a8a、P3 死参数清理 43b8acb）+ 用户亲手 QA 过（b9bc62c/e536a8a/43b8acb）。**#11 随之关闭——M1 实现段完成（3/3）**，地图前沿剩 #2（原型，M2 硬门禁）/#9。
- [M2-01 契约同步落 main](https://github.com/kjiu72063-sudo/skill-observability/issues/16)：prototype/kanban-infoarch 三契约文件逐字搬运 d5c70f8（policy §3.2 action 参数/§3.3 stats/by-rule 端点/§3.4 统计 8 卡口径/§1.3 匹配片段勘误/§6 更新、trace §2.1 live 参数/引号路径注记/§2.3 更新、CONTEXT「看板」术语四区块+SIGIL）；防漂移 diff 为空 + 13 冒烟全绿，逐字性与白名单 Spec 轴实证过、无分支外文本；评审两拍过（第一拍双轴：唯一可执行 finding=残留雾注未入清单 → 票面补记两条、仓库零改动；第二拍通过）；未解决清单 3 条留裁决不阻塞下游（纳秒注记缺失、policy :248 残留雾注矛盾、继承判断项）。**§1.3/引号路径两条地图雾项随本票毕业。M2 看板段 1/12**，下一票 #17（Vite 脚手架）。
- [M2-02 工程脚手架：Vite+React+TS + 纳秒基座 + 单命令出页面](https://github.com/kjiu72063-sudo/skill-observability/issues/17)：dashboard/ 工程一次定型（TS 严格模式、src/api|pages|styles 目录约定、build 产 dist）——后续 8 张前端票只添组件不动工程配置；纳秒无损基座 losslessJson 手写扫描器（*_unix_nano 一律字符串 + 超安全整数保底含指数写法，Node 实证 2^53 边界）；SIGIL 令牌 :root 逐字搬运 + 灰信号色补齐（红/琥珀/灰三色齐，灰=放行）；三族可变字体 woff2 自托管 ~100KB（M7 断网兜底，全仓无 CDN 引用，浏览器资源清单实证全同源）；StaticFiles 挂 demo 装配层 mount_dashboard（不进 create_app，skill_observability/ diff 为空），dist 缺失给构建指引页非白屏；壳页空布局无导航无数据；冒烟 13→16 条 + dashboard 单测 12 条；评审两拍全过（第一拍 5 条全修 a5c00d8：LosslessParsed 类型诚实化/README 收敛一行注记/挂载单点化/文案矛盾/负数用例；第二拍 PASS 逐条 closed）+ 用户亲手 QA 过。P3 两项（--ink3s 命名、DemoDeps.__new__）随 M2-12 消化。**M2 看板段 2/12**，下一票 #18（trace 树区块）。
- [M2-03 看板壳：四区块导航 + 路由 + SIGIL 令牌上壳 + 徽标接真数据](https://github.com/kjiu72063-sudo/skill-observability/issues/18)：侧边栏 4 项导航 + HashRouter 四路由（/#/trace|audit|rules|stats）+ 未知路由兜底；**路由方案 HashRouter 留痕**（评审确认）：StaticFiles(html=True) 无 SPA fallback（GET /trace 404 实测）且 demo.py 禁改，BrowserRouter 刷新落位物理不可达；徽标 Trace/审计接真数据（?page_size=1 取 total，api 层 fetchTotal 封装走 text→parseLossless 真实基座）、规则恒「—」占位等 M2-09、统计无徽标；两枚徽标独立成败落「—」不白屏；SIGIL 令牌全 diff 零裸色（--green 只落健康点=健康非 verdict）；顶栏+健康点属令牌上壳范围（留痕补申报）；回车重跑 total 1→2 实证（实时性归 M2-06）；评审两拍过（第一拍必修两项：A1/C1 规则图标丢 HITL 确认 circle → 助手加 circles 参数补回、J6 纳秒 fixture number 字面量相悖 2^53 决议 → 字符串承载+保串断言，修复 6fd48c8）+ 用户 QA 过；票内 bug 1 条（Sidebar 三态映射写反吞「—」占位，浏览器实测抓到，映射测试防回归）；dashboard 单测 12→27 条 + tsc 0 错 + build 成功 + pytest 16 条绿（后端零触碰）。不修留痕：徽标映射嵌套三元留 /retro、「不新增间距裸值」与无 spacing scale 的措辞矛盾留导师裁决；pytest 根跑需限定 tests/（_tmp_proto_serve 同名测试撞车，#17 遗留）。**M2 看板段 3/12**，下一票 #19（M2-04 Trace 列表）。
- [M2-04 Trace 列表：REST 分页 + 徽标 + 进行中态](https://github.com/kjiu72063-sudo/skill-observability/issues/19)：`/trace` 左栏消费 `GET /api/traces`（契约 §2.1 原样，page/page_size OFFSET 分页、page_size 20），行要素=名称/agent_id 徽标/`MM-DD HH:MM:SS.mmm`/红「拦截」徽标/span 数；**进行中判定 = root `end_time_unix_nano` 为 null（契约语义，非前端计时器）**，徽标取**青色**呼吸（#2 原型 `.b-run` + CONTEXT.md「琥珀=观察期命中」不撞色；**第一拍复审后裁定保留青色，票面「琥珀」措辞作废**，改琥珀只需换 tone）；点行选中态（青底+左青条+底青线，右栏占位回显 id/名称，详情树归 #20），翻页清选中；**翻页状态机 = page 为唯一真相 + effect 取数**（abort + 世代守卫双防竞态；重试回失败页；响应页码越界回落最后一页）；纳秒全程字符串 + BigInt 排序（2^53 以上相邻时间可辨）；空态/错误重试/reduced-motion 齐备；**实测 bug：限高 flex 容器把满页 20 行压到 25px/行、overflow:hidden 裁掉整段 meta** → `.tlist > .trow{flex:none}`（教训入卡：分页/滚动组件必须在满页数据下 QA）；评审两拍（第一拍 P1×2+P2×6；第二拍揪出重试恒回第 1 页/越界页显示「第 3/2 页」/钳制零覆盖 + 2 条假绿测试 → 全部修复并补测）；vitest 27→67 条、pytest 16 条、变异抽查 5 处全抓；浏览器真实数据端到端（21 条 2 页翻页往返/选中/进行中/空态/单条「共 1 条」）验证。**M2 看板段 4/12**，下一票 #20（M2-05 span 树）。
- [M2-05 Trace 详情树：三层建树 + span 详情（M3/M5）](https://github.com/kjiu72063-sudo/skill-observability/issues/20)（**OPEN — 第一拍有条件通过，修复已交 `d04104f`，待第二拍 + 用户 QA + 两项裁决**）：右栏消费 `GET /api/traces/{id}`（契约 §2.2 平铺 spans），`lib/spanTree.ts` 按 `parent_span_id` 前端建树——**孤儿策略显式化**：父不在平铺集（`missingParentCount`）/ 自指 / A↔B 多节点环（三色标记，`cycleCount`）一律升根 + 按类型分别措辞的顶部告警，绝不静默丢弃；节点=名称/kind/时长/状态/三信号徽标（红拦截、琥珀观察期、灰放行）+ 进行中虚线行 spinner，孤儿用弱化琥珀中性徽标（与灰放行显式区分）；**时长口径向 demo 终端对齐**——BigInt 域内加半单位四舍五入到 0.1ms（截断会与 `python demo.py` 的 `{ms:.1f}` 差 0.1；与 Python 二进制半偶仅在 0.05ms 中点差一档，演示数据不落中点）；详情卡 attributes 按 span 对象原样（含点键完整字符串直读、`overflow-wrap:anywhere`）、**M5 events 空数组不渲染卡**、M3 trace_id 全值 + 一键复制（clipboard 优先、execCommand 回退、失败如实回显）、M8「查看审计行」禁用占位；**实测 bug：长键 `skill_observability.matched_rule` 把值挤成竖排 4 行** → `.attr{flex-wrap:wrap}` + `.v{flex:1 1 150px}`；顺带清 #19 复审 P3（`.rail-cap.detail-cap` 提特异性）；vitest 67→106 条 + pytest 16 条 + typecheck/build 全绿；浏览器逐节点时长与终端树**逐字一致**、切换行树替换+选中清空、进行中态、复制（真实手势）、孤儿/环告警同现实测。**第一拍评审（新会话）结论：有条件通过**，已处置 P1 白名单（删越界 `lib/clipboard.ts`；`Trace.css` 越界待裁决并提请固化「区块页样式属隐含项」）、P2「放行」徽标（实现方保留：用户指令原文含「放行灰」> 工单正文，提请裁决）、P3×4 全修。**两项裁决未定 → 未关票，M2 看板段仍 4/12 已关；下一票 #21 需等本票收口。**

## Not yet specified

- 测试策略与 CI 形态（演示项目，最小集待定）。
- README 架构章节的叙事结构。
- 属性键字面量（skill_observability.verdict/matched_rule/error.type=policy.block）在 sdk/printing/db 三处散落——#13 同族 bug 的温床；M2 写统计/前端查询时收编为共享常量（源头 sdk.py，本票禁改未动）。#19 已落一个前端镜像常量 `agent-chip` 语义，常量收编仍待「规则管理」或「统计」片。
- 契约 policy-and-audit.md :248 残留雾注「统计端点不在本契约（口径挂 #2 原型确认，地图 fog）」与已落地的 §3.3/§3.4 直接矛盾——#16 评审两拍认定（继承自分支逐字内容，搬运不代修）；下次动 policy 契约时删除该行并顺检 §3.5 挂节位置（统计端点引用应收在 §4 管理 API 或独立节）。
- 「纳秒时间戳 >2^53 必须 JSON 字符串承载」的契约注记缺失——#2 决议评论 6761569028 是权威出处（#16 验收第 4 条钉死不代补）；下次动 trace/policy 契约时补注，前端各票开工必读该评论。
- 契约 policy §3.4 尾句「from/to 各端点已支持」对 §3.3 stats/by-rule 失准（该端点无 from/to 参数）、观察期口径 :203/:238 两处重复——#16 评审第一拍记录的继承判断项，下次动契约时一并收敛。

## Out of scope

- MCP 适配器、Claude Code/SKILL.md hooks、LangChain 等现有框架接入——README 提名为「下一步适配器」，本图不建票。
- 生产级部署（容器化 / K8s / 高可用 / 水平扩展）。
- 登录、多用户、多租户（agent 身份用配置内 agent_id 区分）。
- ML/LLM 智能违规检测（规则只走声明式匹配：正则/列表/上下文条件）。
- 告警通知与 BI 分析（邮件/Webhook/周报/趋势预测；看板只展示当下与近 7 天）。






