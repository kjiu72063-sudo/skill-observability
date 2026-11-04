"""终端打印：三层缩进树 + 本 run 审计行。数据一律走查询 API 拉回，不直读 DB（#10）。"""

from __future__ import annotations

import httpx

_BASE_INDENT = "  "


def _fmt_duration_ns(start: int, end: int | None) -> str:
    if end is None:
        return "进行中"
    ms = (end - start) / 1_000_000
    return f"{ms:.1f}ms"


def _fmt_span_line(span: dict, depth: int) -> str:
    line = (
        f"{_BASE_INDENT * depth}{span['name']}"
        f" [{_fmt_duration_ns(span['start_time_unix_nano'], span['end_time_unix_nano'])}]"
        f" {span['kind']}"
    )
    attrs = span.get("attributes") or {}
    if span["status_code"] == "ERROR":
        line += f" ERROR: {span.get('status_message') or ''}"
        if attrs.get("error.type") == "policy.block":
            line += f"（规则 {attrs.get('skill_observability.matched_rule')}）"
    elif attrs.get("skill_observability.verdict") == "allow":
        # 观察期命中（audit 规则）：verdict 仍 allow，仅标记
        line += f"（观察期命中 {attrs.get('skill_observability.matched_rule')}）"
    return line


def print_trace_tree(base_url: str, trace_id: str) -> None:
    """按 parent_span_id 建树打印（树形在消费端构建，契约 §2.2）。"""
    resp = httpx.get(f"{base_url}/api/traces/{trace_id}")
    resp.raise_for_status()
    spans = resp.json()["spans"]
    if not spans:
        print(f"（trace {trace_id} 无 span）")
        return
    by_parent: dict[str | None, list[dict]] = {}
    for s in spans:
        by_parent.setdefault(s["parent_span_id"], []).append(s)
    # 契约 §2.2：spans 按 start 升序 → 同层按 start 顺序
    for siblings in by_parent.values():
        siblings.sort(key=lambda s: s["start_time_unix_nano"])

    def walk(span: dict, depth: int) -> None:
        print(_fmt_span_line(span, depth))
        for child in by_parent.get(span["span_id"], []):
            walk(child, depth + 1)

    for root in by_parent.get(None, []):
        print(f"trace {trace_id}")
        walk(root, 1)


def print_run_audits(base_url: str, run_start_unix_nano: int) -> None:
    """本 run 审计行：审计查询 API 按 created_at >= 本 run 起点过滤。"""
    resp = httpx.get(
        f"{base_url}/api/audits",
        params={"from": run_start_unix_nano, "page_size": 100},
    )
    resp.raise_for_status()
    items = resp.json()["items"]
    if not items:
        print("审计：本 run 无记录")
        return
    print(f"审计（本 run {len(items)} 行）：")
    for a in items:
        rule = a["rule_id"] or "—"
        reason = a["reason"] or "未命中任何规则"
        print(
            f"  #{a['id']} {a['tool_name']} verdict={a['verdict']} rule={rule}"
            f" payload={json_compact(a['payload'])}"
            f"\n      理由：{reason}"
        )


def json_compact(obj) -> str:
    import json

    return json.dumps(obj, ensure_ascii=False)
