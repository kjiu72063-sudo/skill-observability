/**
 * 建树 / 时长 / 命中信号的纯函数单测（M2-05 #20）。
 *
 * 建树锚点：契约 trace §2.2 平铺数组按 parent_span_id 组装；孤儿不许静默丢弃。
 * 纳秒锚点：#2 决议钉死字符串承载，19 位纳秒必须 BigInt 运算后再转 Number。
 */

import { describe, expect, it } from "vitest";

import type { TraceSpan } from "../api/traces";
import {
  buildSpanTree,
  formatSpanDuration,
  spanDurationMs,
  spanPolicy,
} from "./spanTree";

function span(overrides: Partial<TraceSpan> & Pick<TraceSpan, "span_id">): TraceSpan {
  return {
    trace_id: "trace-1",
    parent_span_id: null,
    name: "invoke_agent customer-service",
    kind: "INTERNAL",
    start_time_unix_nano: "1794473008218267400",
    end_time_unix_nano: "1794473008370309100",
    status_code: "UNSET",
    status_message: null,
    attributes: { "gen_ai.operation.name": "invoke_agent" },
    events: [],
    agent_id: "customer-service",
    ...overrides,
  };
}

/** 与 python demo.py 终端树同构的一份真实形状 fixture（7 span，三层）。 */
function demoSpans(): TraceSpan[] {
  return [
    span({ span_id: "root" }),
    span({
      span_id: "chat1",
      parent_span_id: "root",
      name: "chat gpt-4o-mini",
      kind: "CLIENT",
      start_time_unix_nano: "1794473008222839500",
      end_time_unix_nano: "1794473008323012700",
      attributes: { "gen_ai.operation.name": "chat" },
    }),
    span({
      span_id: "tool1",
      parent_span_id: "chat1",
      name: "execute_tool query_user_db",
      start_time_unix_nano: "1794473008313710100",
      end_time_unix_nano: "1794473008320084800",
      attributes: { "gen_ai.operation.name": "execute_tool" },
    }),
    span({
      span_id: "chat2",
      parent_span_id: "root",
      name: "chat gpt-4o-mini",
      kind: "CLIENT",
      start_time_unix_nano: "1794473008325913200",
      end_time_unix_nano: "1794473008345820500",
      attributes: { "gen_ai.operation.name": "chat" },
    }),
    span({
      span_id: "tool2",
      parent_span_id: "chat2",
      name: "execute_tool query_contact_by_phone",
      start_time_unix_nano: "1794473008336875000",
      end_time_unix_nano: "1794473008342589000",
      attributes: {
        "gen_ai.operation.name": "execute_tool",
        "skill_observability.verdict": "allow",
        "skill_observability.matched_rule": "r1b-pii-phone-audit",
      },
    }),
    span({
      span_id: "chat3",
      parent_span_id: "root",
      name: "chat gpt-4o-mini",
      kind: "CLIENT",
      start_time_unix_nano: "1794473008349853500",
      end_time_unix_nano: "1794473008367241500",
      attributes: { "gen_ai.operation.name": "chat" },
    }),
    span({
      span_id: "tool3",
      parent_span_id: "chat3",
      name: "execute_tool verify_customer_id",
      start_time_unix_nano: "1794473008359146900",
      end_time_unix_nano: "1794473008364093900",
      status_code: "ERROR",
      status_message: "命中规则 r1-pii-id-card（客户身份证号外泄）：110101199003071234",
      attributes: {
        "gen_ai.operation.name": "execute_tool",
        "error.type": "policy.block",
        "skill_observability.verdict": "block",
        "skill_observability.matched_rule": "r1-pii-id-card",
        "skill_observability.block_reason":
          "命中规则 r1-pii-id-card（客户身份证号外泄）：110101199003071234",
      },
    }),
  ];
}

describe("buildSpanTree（契约 §2.2：前端按 parent_span_id 组装）", () => {
  it("demo 形状 → 1 root + 3 chat + 3 execute_tool，三层挂接正确", () => {
    const { roots, missingParentCount, cycleCount } = buildSpanTree(demoSpans());

    expect(roots).toHaveLength(1);
    expect(missingParentCount).toBe(0);
    expect(cycleCount).toBe(0);
    const root = roots[0];
    expect(root.span.span_id).toBe("root");
    expect(root.children.map((c) => c.span.span_id)).toEqual(["chat1", "chat2", "chat3"]);
    expect(root.children[0].children.map((c) => c.span.span_id)).toEqual(["tool1"]);
    expect(root.children[1].children.map((c) => c.span.span_id)).toEqual(["tool2"]);
    expect(root.children[2].children.map((c) => c.span.span_id)).toEqual(["tool3"]);
    // 三层：tool 节点没有孙辈
    for (const chat of root.children) {
      for (const tool of chat.children) expect(tool.children).toHaveLength(0);
    }
  });

  it("同层按 start 升序（入参乱序也稳定）", () => {
    const spans = demoSpans();
    const shuffled = [spans[3], spans[0], spans[6], spans[2], spans[5], spans[1], spans[4]];
    const { roots } = buildSpanTree(shuffled);
    expect(roots[0].children.map((c) => c.span.span_id)).toEqual(["chat1", "chat2", "chat3"]);
  });

  it("孤儿：父 span 不在本 trace → 挂根并列 + orphan 标记，不静默丢弃", () => {
    const { roots, missingParentCount, cycleCount } = buildSpanTree([
      span({ span_id: "root" }),
      span({ span_id: "lost", parent_span_id: "missing-parent" }),
    ]);

    expect(roots).toHaveLength(2);
    expect(missingParentCount).toBe(1);
    expect(cycleCount).toBe(0);
    const orphan = roots.find((n) => n.span.span_id === "lost");
    expect(orphan?.orphan).toBe(true);
    expect(roots.find((n) => n.span.span_id === "root")?.orphan).toBe(false);
  });

  it("自指 parent（脏数据）→ 按孤儿处理，不无限递归", () => {
    const { roots, missingParentCount, cycleCount } = buildSpanTree([
      span({ span_id: "self", parent_span_id: "self" }),
    ]);
    expect(roots).toHaveLength(1);
    expect(cycleCount).toBe(1);
    expect(missingParentCount).toBe(0);
    expect(roots[0].orphan).toBe(true);
    expect(roots[0].children).toHaveLength(0);
  });

  it("多节点环（A→B→A）→ 环成员全部升根并计数，不丢节点、不互挂", () => {
    // 只处理自指时这两个节点都挂不上根（parent 都在集合内、又不是 null），会被静默丢弃
    const { roots, cycleCount, missingParentCount } = buildSpanTree([
      span({ span_id: "a", parent_span_id: "b" }),
      span({ span_id: "b", parent_span_id: "a" }),
      span({ span_id: "leaf", parent_span_id: "a" }),
      span({ span_id: "ok", parent_span_id: null }),
    ]);

    expect(cycleCount).toBe(2);
    expect(missingParentCount).toBe(0);
    expect(roots.map((r) => r.span.span_id).sort()).toEqual(["a", "b", "ok"]);
    const a = roots.find((r) => r.span.span_id === "a")!;
    const b = roots.find((r) => r.span.span_id === "b")!;
    // 环边被切断：a 的子只有环外的 leaf，b 不挂在 a 下
    expect(a.children.map((c) => c.span.span_id)).toEqual(["leaf"]);
    expect(b.children).toHaveLength(0);
  });

  it("长链不误判为环（深度 3 链 + 正常挂接）", () => {
    const { roots, missingParentCount, cycleCount } = buildSpanTree([
      span({ span_id: "r", parent_span_id: null }),
      span({ span_id: "c", parent_span_id: "r" }),
      span({ span_id: "g", parent_span_id: "c" }),
    ]);
    expect(missingParentCount).toBe(0);
    expect(cycleCount).toBe(0);
    expect(roots[0].children[0].children[0].span.span_id).toBe("g");
  });

  it("空数组 → 空森林", () => {
    expect(buildSpanTree([])).toEqual({ roots: [], missingParentCount: 0, cycleCount: 0 });
  });
});

describe("spanDurationMs / formatSpanDuration（end-start，0.1ms）", () => {
  it("19 位纳秒精确求差（Number 直接相减会丢精度）", () => {
    // 1794473008370309100 - 1794473008218267400 = 152041700 ns = 152.0 ms
    expect(
      spanDurationMs({
        start_time_unix_nano: "1794473008218267400",
        end_time_unix_nano: "1794473008370309100",
      })
    ).toBe(152);
  });

  it("保留一位小数（十进制定点四舍五入到 0.1ms）", () => {
    // 12_399_999 ns = 12.399999 ms → 12.4（四舍五入；截断会得 12.3，与终端打印不一致）。
    // 注意：与 Python f"{ms:.1f}" 仅在 0.05ms 中点边界上可能差一档（Python 走二进制
    // 半偶舍入，12.35ms → 12.3）；演示数据不落中点，故取定点语义。
    expect(
      spanDurationMs({
        start_time_unix_nano: "1000000000000000000",
        end_time_unix_nano: "1000000000012399999",
      })
    ).toBe(12.4);
    // 中点边界：12.35 ms → 12.4（十进制定点语义；Python 此处为 12.3，见上方注释）
    expect(
      spanDurationMs({
        start_time_unix_nano: "1000000000000000000",
        end_time_unix_nano: "1000000000012350000",
      })
    ).toBe(12.4);
    // 低于半位不进：12.34 ms → 12.3
    expect(
      spanDurationMs({
        start_time_unix_nano: "1000000000000000000",
        end_time_unix_nano: "1000000000012340000",
      })
    ).toBe(12.3);
  });

  it("进行中（end=null）→ 时长 null、文案「进行中」", () => {
    const running = { start_time_unix_nano: "1794473008218267400", end_time_unix_nano: null };
    expect(spanDurationMs(running)).toBeNull();
    expect(formatSpanDuration(running)).toBe("进行中");
  });

  it("非法/负时长 → null /「—」，不抛白屏", () => {
    expect(
      spanDurationMs({ start_time_unix_nano: "200", end_time_unix_nano: "100" })
    ).toBeNull();
    expect(
      formatSpanDuration({ start_time_unix_nano: "abc", end_time_unix_nano: "100" })
    ).toBe("—");
  });

  it("正常值格式化为一位小数 + ms", () => {
    expect(
      formatSpanDuration({
        start_time_unix_nano: "1794473008218267400",
        end_time_unix_nano: "1794473008370309100",
      })
    ).toBe("152.0 ms");
  });
});

describe("spanPolicy（attributes 完整键直读，不解析嵌套）", () => {
  it("block span → 红信号 + 规则 + 理由（block_reason 优先）", () => {
    const view = spanPolicy(demoSpans()[6]);
    expect(view.signal).toBe("block");
    expect(view.matchedRule).toBe("r1-pii-id-card");
    expect(view.reason).toContain("r1-pii-id-card");
  });

  it("观察期命中 → 琥珀信号（verdict=allow + matched_rule）", () => {
    const view = spanPolicy(demoSpans()[4]);
    expect(view.signal).toBe("observe");
    expect(view.matchedRule).toBe("r1b-pii-phone-audit");
    expect(view.reason).toBeNull();
  });

  it("已结束且未命中规则的 execute_tool → 灰放行", () => {
    expect(spanPolicy(demoSpans()[2])).toEqual({
      signal: "allow",
      matchedRule: null,
      reason: null,
    });
  });

  it("root/chat span 不贴放行徽标（只有 Skill 调用有 verdict 语义）", () => {
    expect(spanPolicy(demoSpans()[0]).signal).toBeNull();
    expect(spanPolicy(demoSpans()[1]).signal).toBeNull();
  });

  it("进行中的 execute_tool 不判定放行（还没裁决结果）", () => {
    const running = span({
      span_id: "t-run",
      name: "execute_tool slow_tool",
      end_time_unix_nano: null,
      attributes: { "gen_ai.operation.name": "execute_tool" },
    });
    expect(spanPolicy(running).signal).toBeNull();
  });

  it("attributes 缺省/非对象不抛", () => {
    const weird = { ...demoSpans()[2], attributes: undefined as unknown as Record<string, unknown> };
    expect(spanPolicy(weird).signal).toBe("allow");
  });
});
