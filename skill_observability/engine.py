"""策略引擎：``evaluate`` 纯函数全语义（契约 policy §1.2–§1.4）+ 内存快照。

- 匹配 = 两个原语 AND：条件①工具名集合（精确）＋条件②参数正则（递归扫字符串叶子）。
- 求值顺序：过滤 enabled+agent_ids 作用域 → ``(priority asc, id asc)`` 逐条 →
  命中 block 短路 → 否则取最先命中的 audit（观察期）→ 全未命中 ``Verdict("allow", None, None)``。
- 正则与 flags 在快照加载时编译（M1 无写路径，启动加载即满足 #11；M2 写路径
  接管版本比对后，运行时不再因规则问题求值失败——fail-safe 前移到写入时）。
- 引擎不持连接（#8 决议 5「引擎纯函数、不碰 DB」）：快照由外部（demo 启动 /
  将来的 M2 版本比对钩子）通过 :meth:`PolicyEngine.reload` 注入。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

# 匹配侧序列化扫描上限（policy §1.2：64KB，超出截断，防御性上限）
_SCAN_TEXT_CAP_BYTES = 64 * 1024
# reason 匹配片段截断长度（policy §1.3：截断至 80 字符）
_REASON_SNIPPET_MAX = 80
# args_regex.flags 只接受 i/m/s 的任意组合（policy §1.2）
_ALLOWED_FLAG_LETTERS = {"i", "m", "s"}

_FLAG_MAP = {"i": re.IGNORECASE, "m": re.MULTILINE, "s": re.DOTALL}


@dataclass(frozen=True)
class EvalContext:
    """``EvalContext(agent_id, trace_id, span_id)``（policy §1.4）：仅 agent_id 参与匹配。"""

    agent_id: str
    trace_id: str
    span_id: str


@dataclass(frozen=True)
class Verdict:
    """对齐 #8：``Verdict(verdict, matched_rule, reason)``，verdict 只有 allow|block。"""

    verdict: str  # "allow" | "block"
    matched_rule: str | None
    reason: str | None


@dataclass
class Rule:
    id: str
    name: str
    category: str
    action: str  # "block" | "audit"
    enabled: bool
    priority: int
    agent_ids: list[str] | None
    tool_names: list[str] | None
    args_regex: dict | None
    description: str | None
    compiled: re.Pattern | None = field(default=None, repr=False, compare=False)


def _compile_args_regex(spec: dict, rule_id: str) -> tuple[re.Pattern, list[str] | None]:
    pattern = spec.get("pattern")
    if not pattern or not isinstance(pattern, str):
        raise ValueError(f"规则 {rule_id}：args_regex.pattern 必填且为字符串")
    flag_letters = spec.get("flags", "i")
    if not isinstance(flag_letters, str) or not flag_letters:
        raise ValueError(f"规则 {rule_id}：flags 非法（空）")
    unknown = set(flag_letters) - _ALLOWED_FLAG_LETTERS
    if unknown:
        raise ValueError(f"规则 {rule_id}：flags 只接受 i/m/s 组合，含非法 {sorted(unknown)}")
    if len(set(flag_letters)) != len(flag_letters):
        raise ValueError(f"规则 {rule_id}：flags 有重复字母")
    fields = spec.get("fields")
    if fields is not None:
        if not isinstance(fields, list) or not all(isinstance(f, str) for f in fields):
            raise ValueError(f"规则 {rule_id}：fields 必须为 string[] 或 null")
    flags = 0
    for ch in flag_letters:
        flags |= _FLAG_MAP[ch]
    try:
        return re.compile(pattern, flags), fields
    except re.error as e:
        raise ValueError(f"规则 {rule_id}：正则无法编译：{e}") from e


def _iter_string_leaves(node: Any) -> Any:
    """递归收集字符串叶子：dict 的 value、list 的元素；key 名与数字/布尔不参与（policy §1.2）。"""
    if isinstance(node, str):
        yield node
    elif isinstance(node, dict):
        for v in node.values():
            yield from _iter_string_leaves(v)
    elif isinstance(node, (list, tuple)):
        for v in node:
            yield from _iter_string_leaves(v)
    # int/float/bool/None：不参与扫描


def _scan_args(
    args: Any, compiled: re.Pattern, fields: list[str] | None
) -> str | None:
    """返回匹配片段（正则 m.group(0)，对齐契约 §3.2 审计示例），未命中返回 None。"""
    # fields 限定：只扫描 args 顶层同名 key 下的值（policy §1.2）
    if fields:
        roots = [args[k] for k in fields if isinstance(args, dict) and k in args]
    else:
        roots = [args]
    budget = _SCAN_TEXT_CAP_BYTES
    for root in roots:
        for leaf in _iter_string_leaves(root):
            budget -= len(leaf.encode("utf-8"))
            if budget < 0:
                break  # 超出 64KB 截断：余下叶子不再扫描（防御性上限）
            m = compiled.search(leaf)
            if m:
                return m.group(0)
        if budget < 0:
            break
    return None


class PolicyEngine:
    """持内存快照的纯函数引擎；快照经 :meth:`reload` 注入，evaluate 零 DB 读。"""

    def __init__(self) -> None:
        self._rules: tuple[Rule, ...] = ()
        self._version: int | None = None  # None = 未加载

    @property
    def loaded_version(self) -> int | None:
        return self._version

    def reload(self, rule_rows: list[dict], rules_version: int) -> None:
        """构建快照：编译正则（非法即抛，fail-fast）。"""
        rules = []
        for r in rule_rows:
            compiled, fields = (None, None)
            if r.get("args_regex"):
                compiled, fields = _compile_args_regex(r["args_regex"], r["id"])
            rules.append(Rule(
                id=r["id"], name=r["name"], category=r["category"],
                action=r["action"], enabled=r.get("enabled", True),
                priority=r.get("priority", 100),
                agent_ids=r.get("agent_ids"),
                tool_names=r.get("tool_names"),
                args_regex=r.get("args_regex"),
                description=r.get("description"),
                compiled=compiled,
            ))
        self._rules = tuple(rules)
        self._version = rules_version

    def rule_by_id(self, rule_id: str) -> Rule | None:
        for r in self._rules:
            if r.id == rule_id:
                return r
        return None

    # ---------------------------------------------------------------- evaluate（policy §1.3 求值顺序）

    def evaluate(self, tool_name: str, args: Any, context: EvalContext) -> Verdict:
        if self._version is None:
            raise RuntimeError("引擎快照未加载：先调用 reload()（M1 启动加载）")
        # 1) 过滤 enabled=true 且 agent_ids 命中（null/[] = 全局）
        active = [
            r for r in self._rules
            if r.enabled and (not r.agent_ids or context.agent_id in r.agent_ids)
        ]
        # 2) (priority asc, id asc) 排序逐条求值
        first_audit_hit: tuple[Rule, str] | None = None
        for rule in sorted(active, key=lambda r: (r.priority, r.id)):
            snippet = self._match(rule, tool_name, args)
            if snippet is None:
                continue
            # 3) 命中 block → 短路返回
            if rule.action == "block":
                return Verdict("block", rule.id, self._reason(rule, tool_name, snippet))
            # 4) audit（观察期）：命中不拦，记最先命中
            if first_audit_hit is None:
                first_audit_hit = (rule, snippet)
        if first_audit_hit is not None:
            rule, snippet = first_audit_hit
            return Verdict("allow", rule.id, self._reason(rule, tool_name, snippet))
        return Verdict("allow", None, None)

    # ---------------------------------------------------------------- 内部

    @staticmethod
    def _match(rule: Rule, tool_name: str, args: Any) -> str | None:
        # 条件①：工具名集合（null/[] = 任意工具）
        if rule.tool_names and tool_name not in rule.tool_names:
            return None
        # 条件②：参数正则（null = 不限参数）
        if rule.args_regex is None:
            # 两个原语至少一个存在（写路径校验保证）；纯工具名规则命中片段取工具名
            return tool_name
        snippet = _scan_args(args, rule.compiled, rule.args_regex.get("fields"))
        if snippet is None:
            return None
        return snippet

    @staticmethod
    def _reason(rule: Rule, tool_name: str, snippet: str) -> str:
        fragment = snippet
        if len(fragment) > _REASON_SNIPPET_MAX:
            fragment = fragment[:_REASON_SNIPPET_MAX]
        return f"命中规则 {rule.id}（{rule.name}）：{fragment}"
