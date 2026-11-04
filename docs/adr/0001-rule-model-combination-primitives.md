# 规则模型：组合式匹配原语 + 二值 Verdict + 观察期动作

规则引擎若按「规则类型」建模（PII 型 / 危险命令型 / 黑名单型各自参数形状、引擎按类型分派），每加一类规则都要改引擎，且 PII 与危险命令的实现本质都是「正则扫入参」，分型是重复。故规则只有两个匹配原语——**工具名集合、参数正则（AND 组合）**，R1/R2/R3 只是原语组合加展示用的 `category` 标签：新增规则类型零引擎改动，能力边界由原语定义而非类型枚举（R4/R5 由此证伪——频率/配额、输出侧检测需要状态或输出可见性，超出原语边界，是「不支持」而非「支持但不演示」）。

动作只有 `block` / `audit` 两种，verdict 保持 `allow`/`block` 二值：审计本就无论 verdict 全量落库（issue #8），`audit` 动作的独立价值只能是「命中不拦但留标记」，即观察期规则——verdict 仍 allow、`matched_rule` 有值。被否决的替代：引入第三种 verdict（`warn`）会破坏 CONTEXT.md 与 #8 已定的二值 Verdict 结构，让看板与审计多出一种需要解释的状态；「allow 动作短路压过 block」的白名单二阶逻辑同理否决——审计会变得难以解释，演示也用不上。

影响：trace 契约 §3.4 的 `skill_observability.matched_rule` 在「audit 动作命中且 verdict=allow」时也写；规则表、审计表、看板表单与种子数据都按「两原语 + 两动作」固化，后期改形成本高（详见 `docs/contracts/policy-and-audit.md`）。
