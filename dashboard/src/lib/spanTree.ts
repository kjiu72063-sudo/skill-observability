/**
 * Span 平铺数组 → 树 + 展示格式化（M2-05 #20，纯函数，可单测）。
 *
 * 建树按契约 trace §2.2：服务端平铺、前端按 `parent_span_id` 组装，根 = parent 为 null。
 * 孤儿策略（票面硬约束，不许静默丢弃）：父 span 不在本 trace 的平铺集里（含自指）
 * 的节点升级为根级节点并打 orphan 标记，由树组件同时给出「孤儿」徽标与顶部告警。
 *
 * attributes 键含点（`skill_observability.verdict` 等）按**完整键字符串**直读——
 * 与后端 json_extract 含点键必须引号路径同源的教训（契约 trace §2.1 注记）：
 * 不把点当其拆成嵌套对象。
 *
 * 纳秒仍以字符串承载（losslessJson 基座，#2 决议钉死）：时长先用 BigInt 算到
 * 0.1ms 再转 Number，19 位纳秒直接进 Number 会丢精度。
 */

import type { TraceSpan } from "../api/traces";

export interface SpanNode {
  span: TraceSpan;
  children: SpanNode[];
  /** 无法按 parent_span_id 挂进树：父缺失 / 自指 / 环成员。已并列挂到根层，未丢弃 */
  orphan: boolean;
}

export interface SpanTreeView {
  roots: SpanNode[];
  /** 父 span 不在本 trace 的平铺集里（父缺失） */
  missingParentCount: number;
  /** 父链成环（含自指、A↔B）而被切断升根的节点数 */
  cycleCount: number;
}

/** 同层按 start 升序（契约 §2.2 的 ORDER BY 在前端兜底；BigInt 精确比较）。 */
function compareStart(a: TraceSpan, b: TraceSpan): number {
  try {
    const x = BigInt(a.start_time_unix_nano);
    const y = BigInt(b.start_time_unix_nano);
    return x < y ? -1 : x > y ? 1 : 0;
  } catch {
    // 脏数据不白屏：退字典序，至少稳定
    return a.start_time_unix_nano < b.start_time_unix_nano
      ? -1
      : a.start_time_unix_nano > b.start_time_unix_nano
        ? 1
        : 0;
  }
}

function sortDeep(nodes: SpanNode[]): SpanNode[] {
  nodes.sort((a, b) => compareStart(a.span, b.span));
  for (const node of nodes) sortDeep(node.children);
  return nodes;
}

/**
 * 找出 parent 链上游的环成员（脏数据防御）。
 *
 * 自指只是最小情形；A→B→A 这类多节点环若不处理，两个节点都挂不到根上会被
 * 静默丢弃、且在 children 上互挂导致渲染无限递归。三色标记沿 parent 向上走，
 * 撞到「访问中」节点时把路径栈里从它到栈顶的节点全部记为环成员。
 */
function findCycleMembers(nodes: ReadonlyMap<string, SpanNode>): Set<string> {
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const cyclic = new Set<string>();
  const stack: string[] = [];

  const visit = (id: string): void => {
    const c = color.get(id);
    if (c === BLACK) return;
    if (c === GRAY) {
      const from = stack.indexOf(id);
      for (let i = from; i < stack.length; i++) cyclic.add(stack[i]);
      return;
    }
    color.set(id, GRAY);
    stack.push(id);
    const parentId = nodes.get(id)!.span.parent_span_id;
    if (parentId !== null && nodes.has(parentId)) visit(parentId);
    stack.pop();
    color.set(id, BLACK);
  };

  for (const id of nodes.keys()) visit(id);
  return cyclic;
}

/** 平铺 spans → 根节点森林（孤儿显式挂根并计数，绝不静默丢弃）。 */
export function buildSpanTree(spans: readonly TraceSpan[]): SpanTreeView {
  const nodes = new Map<string, SpanNode>();
  for (const span of spans) {
    nodes.set(span.span_id, { span, children: [], orphan: false });
  }

  const cyclic = findCycleMembers(nodes);
  const roots: SpanNode[] = [];
  let missingParentCount = 0;
  let cycleCount = 0;

  for (const node of nodes.values()) {
    const parentId = node.span.parent_span_id;
    if (parentId === null) {
      roots.push(node);
      continue;
    }
    const parent = nodes.get(parentId);
    const isCycle = cyclic.has(node.span.span_id);
    // 环成员一律升根：挂在环里会互挂成环（渲染无限递归），升根是可渲染的最小补救。
    // 环外节点即使父在环里也照常挂载——父已升根，子树无环。
    if (parent !== undefined && parent !== node && !isCycle) {
      parent.children.push(node);
      continue;
    }
    node.orphan = true;
    if (isCycle) cycleCount++;
    else missingParentCount++;
    roots.push(node);
  }

  sortDeep(roots);
  return { roots, missingParentCount, cycleCount };
}

const NS_PER_TENTH_MS = 100_000n;
const NS_PER_HALF_TENTH_MS = 50_000n;

/**
 * end - start（纳秒）→ 毫秒数，保留 0.1ms。
 *
 * 进位方式与 `python demo.py` 的 `f"{ms:.1f}"` 在实测 demo 数据上逐字一致，
 * 但**不是**逐位等价：Python 走 IEEE-754 二进制半偶舍入，本实现是十进制定点
 * 四舍五入，只有恰好落在 0.05ms 中点的值才会差一档（如 12.35ms → 本实现 12.4、
 * Python 12.3，概率约 1e-5）。为保证「同一 span 两处读数一致」这一演示诉求，
 * 取十进制定点；中点边界不在演示数据里出现，未做二进制模拟。
 * 进行中（end 为 null）/ 非法 / 负时长 → null（展示层给出对应文案）。
 */
export function spanDurationMs(span: Pick<TraceSpan, "start_time_unix_nano" | "end_time_unix_nano">): number | null {
  const start = span.start_time_unix_nano;
  const end = span.end_time_unix_nano;
  if (typeof start !== "string" || typeof end !== "string") return null;
  if (!/^\d+$/.test(start) || !/^\d+$/.test(end)) return null;
  try {
    const diff = BigInt(end) - BigInt(start);
    if (diff < 0n) return null;
    // BigInt 域内做四舍五入：先加半个单位再整除，避免 Number 提前丢精度
    return Number((diff + NS_PER_HALF_TENTH_MS) / NS_PER_TENTH_MS) / 10;
  } catch {
    return null;
  }
}

/** 节点时长文案：一位小数 + ms；进行中显示「进行中」；脏数据显示「—」。 */
export function formatSpanDuration(span: Pick<TraceSpan, "start_time_unix_nano" | "end_time_unix_nano">): string {
  if (span.end_time_unix_nano === null) return "进行中";
  const ms = spanDurationMs(span);
  return ms === null ? "—" : `${ms.toFixed(1)} ms`;
}

/** 状态文案：UNSET 是正常态（成功不写 OK），ERROR 才是异常。 */
export function formatSpanStatus(
  span: Pick<TraceSpan, "status_code" | "status_message">
): string {
  const code = span.status_code || "UNSET";
  if (span.status_message !== null && span.status_message !== "") {
    return `${code} — ${span.status_message}`;
  }
  return code;
}

/** 三信号徽标（CONTEXT.md 看板术语）：红=拦截 / 琥珀=观察期命中 / 灰=放行。 */
export type PolicySignal = "block" | "observe" | "allow";

export interface SpanPolicyView {
  signal: PolicySignal | null;
  matchedRule: string | null;
  /** 拦截理由（attributes 的 block_reason，缺省回退 status_message） */
  reason: string | null;
}

function isExecuteToolSpan(span: TraceSpan): boolean {
  const op = span.attributes?.["gen_ai.operation.name"];
  // 脏数据防御：name 非字符串时退「非 Skill 调用」（不抛，展示层不白屏）
  return op === "execute_tool" || (typeof span.name === "string" && span.name.startsWith("execute_tool "));
}

/**
 * 从 attributes 的 `skill_observability.*` 完整键读命中信号（不解析嵌套）：
 * - block 必写 verdict/block_reason；error.type=policy.block 作为兜底同判拦截；
 * - 观察期命中：verdict=allow + matched_rule（契约 §3.4 写入时机）；
 * - 其余已结束的成功 Skill 调用 = 放行（灰）；root/chat span 与异常 span 不贴放行。
 */
export function spanPolicy(span: TraceSpan): SpanPolicyView {
  const attrs = span.attributes ?? {};
  const verdict = attrs["skill_observability.verdict"];
  const matched = attrs["skill_observability.matched_rule"];
  const blockReason = attrs["skill_observability.block_reason"];

  if (verdict === "block" || attrs["error.type"] === "policy.block") {
    return {
      signal: "block",
      matchedRule: typeof matched === "string" && matched !== "" ? matched : null,
      reason:
        typeof blockReason === "string" && blockReason !== ""
          ? blockReason
          : (span.status_message ?? null),
    };
  }

  if (verdict === "allow" && typeof matched === "string" && matched !== "") {
    return { signal: "observe", matchedRule: matched, reason: null };
  }

  if (
    isExecuteToolSpan(span) &&
    span.status_code !== "ERROR" &&
    span.end_time_unix_nano !== null
  ) {
    return { signal: "allow", matchedRule: null, reason: null };
  }

  return { signal: null, matchedRule: null, reason: null };
}
