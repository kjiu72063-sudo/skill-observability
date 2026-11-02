# skill-observability（Agent Skill 合规可观测平台）

给 AI Agent 的 Skill/工具调用提供全链路 Trace、合规策略拦截与审计、可视化看板的平台。

## Language

**Skill 调用（Tool Call）**：
agent 运行时对单个工具的一次同步调用，是本平台采集、拦截与审计的最小单位。
_Avoid_: action、function call（对外文案统一称「Skill 调用」）

**Trace**：
一次 agent 任务从发起到结束的全链路调用树，由嵌套的 span 组成。

**Span**：
trace 中的一个节点，对应一次 LLM 调用或一次 Skill 调用；字段命名沿用 OpenTelemetry 的语义约定（仅字段，不含其采集管道）。

**策略引擎**：
在每次 Skill 调用执行前同步运行的规则组件，对调用作出放行或拦截裁决。

**Verdict**：
策略引擎对一次 Skill 调用的裁决结果，只有两种：allow 或 block（block 附带理由）。
_Avoid_: decision、result

**规则（Rule）**：
一条声明式合规策略，由匹配条件、动作与作用域组成。本项目三类规则：R1 敏感数据（PII）、R2 危险命令、R3 工具黑白名单。
_Avoid_: policy（单指一条时用「规则」，规则集合才称「策略」）

**拦截（Block）**：
verdict 为 block 时该 Skill 调用不被执行，agent 收到拒绝与理由，并终止对应子任务（不改道重试）。
_Avoid_: 拒绝、禁用、熔断

**审计记录（Audit Record）**：
每次 Skill 调用无论 verdict 如何都写入的一条合规日志，含 verdict、命中规则、payload 快照及其 trace 关联。
_Avoid_: 审计条目、违规记录（违规仅是 verdict=block 的子集）

**埋点 SDK**：
进程内 Python 包，agent 用它包住每次 Skill 调用，完成 span 上报与策略引擎拦截点调用。

**演示场景配置**：
同一套 agent 运行时代码的一份配置 = 系统提示词 + 工具清单 + 预置数据。客服与运维是两套配置，不是两个 agent。
_Avoid_: 双 agent、demo bot
