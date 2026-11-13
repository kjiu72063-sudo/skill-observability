/**
 * 审计列表取数（M2-07 #22）：契约 policy §3.2 原样消费 `GET /api/audits`。
 *
 * - **筛选口径唯一出自服务端**（票面纪律）：四段筛选各自映射为契约查询参数，
 *   前端不做任何行级过滤。`观察期` = `action=audit`（契约 §3.2 新增参数，口径与
 *   §3.4 卡 5 同源）；`放行` = `verdict=allow`——**含观察期命中行**（命中观察期
 *   规则不拦截，verdict 仍是 allow，与原型一致）。
 * - `created_at_unix_nano` 经 client 基座（losslessJson）以字符串进组件树
 *   （>2^53 丢精度，#2 决议钉死）；展示格式化复用 Trace 列表同一实现，不复制一份。
 * - 形状守卫与 traces.ts 同风格：缺字段抛普通 Error，不装 ApiError。
 */

import { apiGet } from "./client";
import { formatNanoTime, formatTraceDate } from "./traces";

/** 列表页默认页大小（契约 §3.2 默认值 20）。 */
export const AUDIT_PAGE_SIZE = 20;

/**
 * 四段筛选（票面：全部 / 拦截 / 放行 / 观察期）。
 * 键名是 UI 语义，值到查询参数的映射见 {@link auditQuery}——这是唯一的映射点。
 */
export type AuditFilter = "all" | "block" | "allow" | "observe";

/** 分段定义（渲染顺序 = 原型 .seg 顺序）：全部 / 拦截 / 放行 / 观察期。 */
export const AUDIT_FILTERS: ReadonlyArray<{ key: AuditFilter; label: string }> = [
  { key: "all", label: "全部" },
  { key: "block", label: "拦截" },
  { key: "allow", label: "放行" },
  { key: "observe", label: "观察期" },
];

/** 契约 §3.2 列表项（payload 不消费——展开归 M2-08）。 */
export interface AuditListItem {
  id: number;
  trace_id: string;
  span_id: string;
  agent_id: string;
  tool_name: string;
  verdict: "allow" | "block";
  /** NULL = 未命中任何规则 */
  rule_id: string | null;
  rule_name: string | null;
  /** 命中规则的动作；NULL = 未命中 */
  action: "block" | "audit" | null;
  reason: string | null;
  /** 8KB 上限截断标志（契约 §3.1） */
  payload_truncated: boolean;
  /** 纳秒字符串（无损承载） */
  created_at_unix_nano: string;
}

/** 契约 §3.2 分页响应（形状沿用 trace §2.1）。 */
export interface AuditListPage {
  items: AuditListItem[];
  page: number;
  page_size: number;
  total: number;
}

/**
 * 筛选段 → 查询参数。空对象 = 不带筛选（全部）。
 *
 * 「观察期」只发 `action=audit`，不回显 `verdict=allow`——该 AND 语义由服务端
 * 契约定义（§3.2）；前端再补一个 verdict 会让口径出现第二处来源。
 */
export function auditQuery(filter: AuditFilter): Record<string, string> {
  switch (filter) {
    case "block":
      return { verdict: "block" };
    case "allow":
      return { verdict: "allow" };
    case "observe":
      return { action: "audit" };
    case "all":
      return {};
  }
}

/** `GET /api/audits?page=&page_size=[&verdict=|&action=]`：OFFSET 分页快照。 */
export async function fetchAudits(
  page: number,
  filter: AuditFilter,
  pageSize: number = AUDIT_PAGE_SIZE,
  signal?: AbortSignal
): Promise<AuditListPage> {
  const query = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
  for (const [k, v] of Object.entries(auditQuery(filter))) query.set(k, v);
  const body = await apiGet<AuditListPage>(`/audits?${query.toString()}`, signal);
  if (!Array.isArray(body.items) || typeof body.total !== "number") {
    throw new Error(`GET /api/audits 响应形状异常（缺 items/total，page=${page}）`);
  }
  return body;
}

/** 三徽标语义（CONTEXT.md 看板术语）：红=拦截 / 琥珀=观察期命中 / 灰=放行。 */
export type VerdictTone = "block" | "observe" | "allow";

/**
 * 徽标分档（纯展示映射，不是过滤）：block 优先；allow 且 action=audit 为观察期命中；
 * 其余 allow 为放行。观察期命中行的 verdict 仍是 allow（审计表事实如此）。
 */
export function verdictTone(row: Pick<AuditListItem, "verdict" | "action">): VerdictTone {
  if (row.verdict === "block") return "block";
  if (row.action === "audit") return "observe";
  return "allow";
}

/** 时间列：`MM-DD HH:MM:SS.mmm`（与 Trace 列表同格式，时区本地）。 */
export function formatAuditTime(nano: string | null | undefined): string {
  const date = formatTraceDate(nano);
  if (date === "—") return "—";
  return `${date} ${formatNanoTime(nano)}`;
}
