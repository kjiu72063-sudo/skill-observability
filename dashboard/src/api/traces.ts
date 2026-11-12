/**
 * Trace 列表取数（M2-04 #19）：契约 trace §2.1 原样消费 `GET /api/traces`。
 *
 * - `*_unix_nano` 经 client 基座（losslessJson）以字符串进组件树（>2^53 丢精度，
 *   #2 决议钉死）——本层不转 number，格式化留给展示组件。
 * - 分页只做 OFFSET 翻页（page/page_size），不做总页数跳转（契约形状如此）。
 * - 列表排序在前端做（票面纪律）：纳秒字符串必须 BigInt 比较，Number 比较在
 *   2^53 以上会把相邻时间判成相等。
 * - 形状守卫与 client.fetchTotal 同风格：缺字段抛普通 Error，不装 ApiError
 *   （不是 HTTP 错误，调用方按同一条错误路径处理）。
 */

import { apiGet } from "./client";

/** 列表页默认页大小（契约 §2.1 默认值 20）。 */
export const TRACE_PAGE_SIZE = 20;

/** 契约 trace §2.1 列表项：以 root span 为行单位。 */
export interface TraceListItem {
  trace_id: string;
  name: string;
  agent_id: string | null;
  /** 纳秒字符串（无损承载） */
  start_time_unix_nano: string;
  /** 纳秒字符串；null = 进行中（root span 未结束，契约语义） */
  end_time_unix_nano: string | null;
  status_code: string;
  span_count: number;
  /** 任一 span verdict=block；仅展示字段，不是过滤参数 */
  blocked: boolean;
}

/** 契约 trace §2.1 分页响应。 */
export interface TraceListPage {
  items: TraceListItem[];
  page: number;
  page_size: number;
  total: number;
}

/**
 * 契约 trace §2.2 详情里的 span 对象（表列原样，attributes/events 已解析）。
 * 纳秒为字符串（losslessJson 基座）；end 为 null = 进行中。
 */
export interface TraceSpan {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  kind: string;
  start_time_unix_nano: string;
  end_time_unix_nano: string | null;
  status_code: string;
  status_message: string | null;
  /** 键名含点（gen_ai.*、skill_observability.*）——按完整键字符串读，不解析嵌套 */
  attributes: Record<string, unknown>;
  /** 空数组 = 无事件（M5：不渲染 events 卡） */
  events: SpanEvent[];
  agent_id: string | null;
}

/** span 事件（OTel 形状：name + timestamp + attributes）。 */
export interface SpanEvent {
  name?: string;
  timestamp?: string | number;
  attributes?: Record<string, unknown>;
  [key: string]: unknown;
}

/** 契约 trace §2.2 详情响应：平铺数组，服务端不递归。 */
export interface TraceDetail {
  trace_id: string;
  spans: TraceSpan[];
}

/** `GET /api/traces?page=&page_size=`：OFFSET 分页快照（SSE 实时插入归 M2-06）。 */
export async function fetchTraces(
  page: number,
  pageSize: number = TRACE_PAGE_SIZE,
  signal?: AbortSignal
): Promise<TraceListPage> {
  const query = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
  const body = await apiGet<TraceListPage>(`/traces?${query.toString()}`, signal);
  if (!Array.isArray(body.items) || typeof body.total !== "number") {
    throw new Error(`GET /api/traces 响应形状异常（缺 items/total，page=${page}）`);
  }
  return body;
}

/**
 * `GET /api/traces/{trace_id}`：平铺 spans 数组（契约 §2.2），树形在前端建。
 * 404 由调用方按 ApiError.status 区分文案（trace 不存在 ≠ 服务故障）。
 */
export async function fetchTraceDetail(
  traceId: string,
  signal?: AbortSignal
): Promise<TraceDetail> {
  const body = await apiGet<TraceDetail>(`/traces/${encodeURIComponent(traceId)}`, signal);
  if (!Array.isArray(body.spans)) {
    throw new Error(`GET /api/traces/${traceId} 响应形状异常（缺 spans）`);
  }
  return body;
}

/** 前端排序：root start_time_unix_nano 倒序（后端已 ORDER BY DESC，此层兜底 + 测试锚点）。 */
export function sortTraceItemsDesc(items: readonly TraceListItem[]): TraceListItem[] {
  return [...items].sort((a, b) => compareNano(a.start_time_unix_nano, b.start_time_unix_nano) * -1);
}

/** 纳秒字符串比较：BigInt 精确比较；非法值回退字典序，绝不抛（展示层不因脏数据白屏）。 */
function compareNano(a: string, b: string): number {
  try {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  } catch {
    return a < b ? -1 : a > b ? 1 : 0;
  }
}

/* ---- 纳秒字符串 → 展示文本（票面：时间格式化归列表封装层，不进组件） ---- */

const MS_PER_NANO = 1_000_000n;

/** 纳秒字符串 → 毫秒数（安全整数范围）；非法/超范围返回 null。 */
function nanoToMs(nano: string | null | undefined): number | null {
  if (typeof nano !== "string" || !/^-?\d+$/.test(nano)) return null;
  try {
    // 先 BigInt 除到毫秒再转 Number：19 位纳秒直接 Number() 已丢精度
    const ms = BigInt(nano) / MS_PER_NANO;
    const num = Number(ms);
    if (!Number.isFinite(num) || Math.abs(num) > 8.64e15) return null; // Date 有效范围
    return num;
  } catch {
    return null;
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 纳秒字符串 → `HH:MM:SS.mmm`（本地时区）；非法输入返回「—」，不抛。 */
export function formatNanoTime(nano: string | null | undefined): string {
  const ms = nanoToMs(nano);
  if (ms === null) return "—";
  const d = new Date(ms);
  return (
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}` +
    `.${String(d.getMilliseconds()).padStart(3, "0")}`
  );
}

/** 纳秒字符串 → `MM-DD`（本地时区）；非法输入返回「—」。 */
export function formatTraceDate(nano: string | null | undefined): string {
  const ms = nanoToMs(nano);
  if (ms === null) return "—";
  const d = new Date(ms);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 进行中判定：root span 的 end_time_unix_nano 为 null（契约语义，不是前端计时器）。 */
export function isInProgress(item: Pick<TraceListItem, "end_time_unix_nano">): boolean {
  return item.end_time_unix_nano === null;
}
