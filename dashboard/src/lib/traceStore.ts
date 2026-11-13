/**
 * Trace 实时状态层（M2-06 #21）：REST 初值与 SSE 事件合并的唯一真相。
 *
 * 合并语义（票面钉死）：
 * - 按 `span_id` 幂等 upsert：`span.start` 最小字段 + 默认值补齐（end=null /
 *   status="UNSET" / attributes={} / events=[]），`span.end` 整行快照**全量覆盖**；
 * - REST 初值打底：回放的 `span.start` 不能把 REST 已见到的终态「降级」回进行中，
 *   同 span_id 不产生重复节点；
 * - 列表合并只作用第 1 页（由 Trace 页决定是否调用 `mergeLiveTraceList`），
 *   全新 trace 的 root start 才插行——乱序非 root 事件不硬造行（契约 §3 假设
 *   start 先于 end，污数据按 upsert 自然兜底即可）。
 *
 * 连接生命周期：#2 的 M2 注意项要求 StrictMode 双挂载下只有 1 条 EventSource、
 * 离开 Trace 页不断流——因此连接挂在模块级单例上（首个订阅者触发，永不随组件
 * 卸载关闭），重连完全交给浏览器原生 `Last-Event-ID` 语义，不做轮询、不自研重连。
 *
 * 纳秒：SSE 的 `event.data` 已在 sse.ts 走 parseLossless，本层只按字符串承载，
 * 排序比较用 BigInt。
 */

import { useSyncExternalStore, useEffect, useMemo, useRef, useState } from "react";

import { ApiError } from "../api/client";
import {
  fetchTraceDetail,
  sortTraceItemsDesc,
  type SpanEvent,
  type TraceListItem,
  type TraceSpan,
} from "../api/traces";
import {
  browserEventSourceFactory,
  openSpanStream,
  type EventSourceFactory,
  type SpanEventKind,
  type SpanStream,
} from "./sse";
import { spanPolicy } from "./spanTree";

/** 实时流状态：static = 当前环境无 EventSource（jsdom 单测），不显示任何提示。 */
export type StreamStatus = "static" | "connecting" | "open" | "error";

/* ---------------------------------------------------------------- 事件 → span 归一化 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 纳秒值 → 字符串：lossless 基座保证字符串；测试/脏数据里的小整数容忍为字符串。 */
function nanoText(value: unknown): string | null {
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * SSE 事件体 → `TraceSpan`（字段恒定义，绝不把 undefined 漏进组件）。
 * 关键字段（trace_id/span_id/name/start）缺失 → null，整条脏事件丢弃。
 * `span.start` 的正常路径没有 end/status/attributes/events——在此补默认。
 */
export function normalizeSpanPayload(kind: SpanEventKind, data: unknown): TraceSpan | null {
  if (!isRecord(data)) return null;
  const traceId = textOrNull(data.trace_id);
  const spanId = textOrNull(data.span_id);
  const start = nanoText(data.start_time_unix_nano);
  const name = textOrNull(data.name);
  if (traceId === null || spanId === null || start === null || name === null) return null;

  return {
    trace_id: traceId,
    span_id: spanId,
    parent_span_id: textOrNull(data.parent_span_id),
    name,
    kind: textOrNull(data.kind) ?? "INTERNAL",
    start_time_unix_nano: start,
    end_time_unix_nano: kind === "span.end" ? nanoText(data.end_time_unix_nano) : null,
    status_code: textOrNull(data.status_code) ?? "UNSET",
    status_message: textOrNull(data.status_message),
    attributes: isRecord(data.attributes) ? data.attributes : {},
    events: Array.isArray(data.events) ? (data.events as SpanEvent[]) : [],
    agent_id: textOrNull(data.agent_id),
  };
}

/**
 * `span.start` 合并：已存在的终态**不回退**（REST 或先前 end 比回放的 start 新）；
 * 进行中记录保留更全的列（REST 中途快照的 attributes 比 start 最小字段全）。
 */
export function applySpanStart(existing: TraceSpan | undefined, incoming: TraceSpan): TraceSpan {
  if (existing === undefined) return incoming;
  if (existing.end_time_unix_nano !== null) return existing;
  return {
    ...existing,
    ...incoming,
    end_time_unix_nano: null,
    status_code: incoming.status_code === "UNSET" ? existing.status_code : incoming.status_code,
    status_message: existing.status_message ?? incoming.status_message,
    attributes:
      Object.keys(incoming.attributes).length > 0 ? incoming.attributes : existing.attributes,
    events: incoming.events.length > 0 ? incoming.events : existing.events,
  };
}

/** `span.end` 合并：整行快照全量覆盖（契约 §3.2），旧记录一个字段都不保留。 */
export function applySpanEnd(existing: TraceSpan | undefined, incoming: TraceSpan): TraceSpan {
  return existing === undefined ? incoming : { ...incoming };
}

/**
 * REST 初值 + SSE 记录 → 合并后的平铺 spans（同 span_id 只留一条）。
 * REST 已是终态而回放 start 只是旧快照时，以 REST 为准（不降级、不重复）。
 */
export function mergeSpans(
  rest: readonly TraceSpan[],
  live: ReadonlyMap<string, TraceSpan> | undefined
): TraceSpan[] {
  if (live === undefined || live.size === 0) return [...rest];
  const byId = new Map<string, TraceSpan>();
  for (const span of rest) byId.set(span.span_id, span);
  for (const [spanId, span] of live) {
    const base = byId.get(spanId);
    if (base === undefined) {
      byId.set(spanId, span);
      continue;
    }
    if (span.end_time_unix_nano !== null) {
      byId.set(spanId, span);
      continue;
    }
    if (base.end_time_unix_nano !== null) continue;
    byId.set(spanId, applySpanStart(base, span));
  }
  return [...byId.values()];
}

/* ---------------------------------------------------------------- 列表行实时增量 */

/** 纯 SSE 推导出的 trace 行（root 已出现才有）；字段与 REST 列表项同形。 */
export interface LiveTraceRow {
  trace_id: string;
  name: string;
  agent_id: string | null;
  start_time_unix_nano: string;
  end_time_unix_nano: string | null;
  status_code: string;
  span_count: number;
  blocked: boolean;
}

interface LiveBucket {
  row: LiveTraceRow | null;
  /** 该 trace 见过的 span_id 集合（span_count 口径 = 去重 span 数）。 */
  seen: Set<string>;
  /** 任一 span 命中拦截（root start 到达前也可能先见到子 span 的 block）。 */
  blocked: boolean;
}

function rowFromSpan(span: TraceSpan): LiveTraceRow {
  return {
    trace_id: span.trace_id,
    name: span.name,
    agent_id: span.agent_id,
    start_time_unix_nano: span.start_time_unix_nano,
    end_time_unix_nano: span.end_time_unix_nano,
    status_code: span.status_code,
    span_count: 1,
    blocked: spanPolicy(span).signal === "block",
  };
}

/** 纳秒字符串比较：BigInt 精确；非法值退字典序，绝不抛（展示层不白屏）。 */
function compareNanoText(a: string, b: string): number {
  try {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  } catch {
    return a < b ? -1 : a > b ? 1 : 0;
  }
}

function liveRowToListItem(row: LiveTraceRow): TraceListItem {
  return {
    trace_id: row.trace_id,
    name: row.name,
    agent_id: row.agent_id,
    start_time_unix_nano: row.start_time_unix_nano,
    end_time_unix_nano: row.end_time_unix_nano,
    status_code: row.status_code,
    span_count: row.span_count,
    blocked: row.blocked,
  };
}

/**
 * REST 第 1 页 + 实时增量 → 展示用列表。
 * - 已有行按 trace_id 叠加（root 收口、span 数取两者较大、拦截徽标单调增）；
 * - 新 trace 行插到顶部，并按 pageSize 截断（只显示最新一页）；
 * - **fresh 的判定 = 「不在本页且比本页最新一行更新」**。这个基准线同时解决三件事：
 *   ① 首连全量回放的历史 trace 早已被 REST total 计入，不能重复计数/插行；
 *   ② 更老的新 trace 属于后面的页，插进第 1 页会和分页语义打架；
 *   ③ 服务端换库（demo.py 每次启动删库）后，状态层残留的旧 live 行会全部落在
 *      基准线之下——自然被剔除，不会在列表里诈尸。
 * - `inserted` = fresh 的总数（REST 快照之后新出现的 trace），分页控件用
 *   `total + inserted` 显示真数；REST 为空（无基准线）时全部算新增。
 */
export function mergeLiveTraceList(
  items: readonly TraceListItem[],
  live: ReadonlyMap<string, LiveTraceRow>,
  pageSize: number
): { items: TraceListItem[]; inserted: number } {
  const known = new Set(items.map((item) => item.trace_id));
  const overlaid = items.map((item) => {
    const row = live.get(item.trace_id);
    if (row === undefined) return item;
    return {
      ...item,
      end_time_unix_nano: row.end_time_unix_nano ?? item.end_time_unix_nano,
      status_code: row.end_time_unix_nano !== null ? row.status_code : item.status_code,
      span_count: Math.max(item.span_count, row.span_count),
      blocked: item.blocked || row.blocked,
    };
  });

  let watermark: string | null = null;
  for (const item of items) {
    if (watermark === null || compareNanoText(item.start_time_unix_nano, watermark) > 0) {
      watermark = item.start_time_unix_nano;
    }
  }

  const fresh = [...live.values()].filter(
    (row) =>
      !known.has(row.trace_id) &&
      (watermark === null || compareNanoText(row.start_time_unix_nano, watermark) > 0)
  );

  const merged = sortTraceItemsDesc([...fresh.map(liveRowToListItem), ...overlaid]);
  return { items: merged.slice(0, Math.max(pageSize, 1)), inserted: fresh.length };
}

/* ---------------------------------------------------------------- 详情取数状态 */

export type TraceDetailView =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; spans: TraceSpan[] };

type RestDetailState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; spans: TraceSpan[] };

function detailErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    return err.status === 404
      ? "trace 不存在（可能已被重置数据库移除）"
      : `取数失败（HTTP ${err.status}）：${err.detail}`;
  }
  return err instanceof Error ? err.message : "取数失败";
}

/* ---------------------------------------------------------------- 单例 Store */

type Listener = () => void;

export class TraceStore {
  private readonly listeners = new Set<Listener>();
  private readonly liveSpans = new Map<string, Map<string, TraceSpan>>();
  private readonly buckets = new Map<string, LiveBucket>();
  private readonly restDetails = new Map<string, RestDetailState>();
  private readonly requestSeq = new Map<string, number>();
  private readonly pendingDetails = new Set<string>();
  private readonly factory: EventSourceFactory | null;
  private stream: SpanStream | null = null;
  private status: StreamStatus;
  private version = 0;
  /** 重连成功（error → open）的次数：REST 重同步的触发器，见 Trace.tsx。 */
  private resyncCount = 0;

  constructor(factory: EventSourceFactory | null) {
    this.factory = factory;
    // 没有 EventSource 的环境（jsdom）直接 static：不打开任何连接，REST 正常工作。
    this.status = factory === null ? "static" : "connecting";
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    // 常驻连接：首个订阅者触发；后续订阅（含 StrictMode 二次挂载）复用它。
    this.ensureConnected();
    return () => {
      this.listeners.delete(listener);
      // 刻意不关流：离开 Trace 页后侧栏徽标仍要随事件增长（票面纪律）。
    };
  };

  getVersion = (): number => this.version;

  getStatus = (): StreamStatus => this.status;

  /** 重连成功次数（只增）：页面据此重取 REST，兜住「断线期间服务换库」的空洞。 */
  getResyncCount = (): number => this.resyncCount;

  ensureConnected(): void {
    if (this.stream !== null || this.factory === null) return;
    this.stream = openSpanStream(
      {
        onEvent: (kind, data) => this.dispatch(kind, data),
        onStatus: (next) => {
          // 'open' / 'error' 两种回调都可能重复触发；同值不通知，避免无谓渲染。
          if (this.status === next) return;
          // error → open = 浏览器用 Last-Event-ID 重连成功。此时让页面重取 REST：
          // 断线期间服务若重启过（demo.py 每次启动删库），event_log 的 id 会从头开始，
          // 浏览器的旧游标比新库里所有 id 都大 → 续传事件全被服务端判「已回放」丢弃，
          // 只靠 SSE 会出现永久空洞。REST 重同步是可观测的最新真相，必须补这一步。
          if (next === "open" && this.status === "error") this.resyncCount++;
          this.status = next;
          this.bump();
        },
      },
      this.factory
    );
  }

  /** 事件入口：SSE 监听与单测共用（单测直接喂原始 payload 对象）。 */
  dispatch(kind: SpanEventKind, data: unknown): void {
    const span = normalizeSpanPayload(kind, data);
    if (span === null) return; // 脏事件丢弃，不打断整条流

    const traceId = span.trace_id;
    let spans = this.liveSpans.get(traceId);
    if (spans === undefined) {
      spans = new Map();
      this.liveSpans.set(traceId, spans);
    }
    const previous = spans.get(span.span_id);
    spans.set(
      span.span_id,
      kind === "span.start" ? applySpanStart(previous, span) : applySpanEnd(previous, span)
    );

    let bucket = this.buckets.get(traceId);
    if (bucket === undefined) {
      bucket = { row: null, seen: new Set(), blocked: false };
      this.buckets.set(traceId, bucket);
    }
    bucket.seen.add(span.span_id);
    if (spanPolicy(span).signal === "block") bucket.blocked = true;

    if (span.parent_span_id === null) {
      // root：建行 / 收口。start 只补身份字段，end 全量快照才动 end/status
      //（乱序到达的旧 start 不许把已收口的行降级回进行中）。
      const row = bucket.row ?? rowFromSpan(span);
      row.name = span.name;
      row.agent_id = span.agent_id;
      row.start_time_unix_nano = span.start_time_unix_nano;
      if (span.end_time_unix_nano !== null) {
        row.end_time_unix_nano = span.end_time_unix_nano;
        row.status_code = span.status_code;
      }
      bucket.row = row;
    }
    if (bucket.row !== null) {
      bucket.row.blocked = bucket.blocked;
      bucket.row.span_count = bucket.seen.size;
    }

    this.bump();
  }

  getLiveSpans(traceId: string): ReadonlyMap<string, TraceSpan> | undefined {
    return this.liveSpans.get(traceId);
  }

  getLiveRows(): ReadonlyMap<string, LiveTraceRow> {
    const rows = new Map<string, LiveTraceRow>();
    for (const [traceId, bucket] of this.buckets) {
      if (bucket.row !== null) rows.set(traceId, bucket.row);
    }
    return rows;
  }

  /** 详情视图：REST 打底 + 实时合并；SSE 先到也可直接 ready（不空等 REST）。 */
  getDetailView(traceId: string): TraceDetailView {
    const rest = this.restDetails.get(traceId);
    const live = this.liveSpans.get(traceId);
    const liveCount = live?.size ?? 0;
    if (rest?.kind === "ready") {
      return { kind: "ready", spans: mergeSpans(rest.spans, live) };
    }
    if (rest?.kind === "error") {
      // REST 失败但实时流已有该 trace 的 span：有数据先给数据，错误态让位。
      if (liveCount > 0) return { kind: "ready", spans: mergeSpans([], live) };
      return { kind: "error", message: rest.message };
    }
    if (liveCount > 0) return { kind: "ready", spans: mergeSpans([], live) };
    return { kind: "loading" };
  }

  /**
   * 取 REST 详情（契约 §2.2）打底。
   * - 已取过仍会再取一次：重新进入详情时以 REST 刷新打底（期间旧数据保持可见，
   *   不闪 loading）；滚动期间只靠 SSE 增量，不重取。
   * - 并发去重：StrictMode 双挂载在同一个提交阶段触发两次 effect，只发一次请求。
   * - 世代守卫：同一 trace 的旧响应晚到，不覆盖新响应。
   */
  requestTraceDetail(traceId: string, force = false): void {
    if (!force && this.pendingDetails.has(traceId)) return;
    this.pendingDetails.add(traceId);

    const previous = this.restDetails.get(traceId);
    if (previous?.kind !== "ready") this.restDetails.set(traceId, { kind: "loading" });
    this.bump();

    const seq = (this.requestSeq.get(traceId) ?? 0) + 1;
    this.requestSeq.set(traceId, seq);
    const settle = (): void => {
      if (this.requestSeq.get(traceId) === seq) this.pendingDetails.delete(traceId);
    };

    fetchTraceDetail(traceId)
      .then((detail) => {
        if (this.requestSeq.get(traceId) !== seq) return; // 旧响应：丢弃，不覆盖
        this.restDetails.set(traceId, { kind: "ready", spans: detail.spans });
        settle();
        this.bump();
      })
      .catch((err: unknown) => {
        if (this.requestSeq.get(traceId) !== seq) return;
        this.restDetails.set(traceId, { kind: "error", message: detailErrorMessage(err) });
        settle();
        this.bump();
      });
  }

  retryTraceDetail(traceId: string): void {
    this.requestTraceDetail(traceId, true);
  }

  private bump(): void {
    this.version++;
    for (const listener of this.listeners) listener();
  }
}

/** 模块级单例：连接常驻、跨路由存活（票面：离开 Trace 页不断流）。 */
export const traceStore = new TraceStore(browserEventSourceFactory);

/* ---------------------------------------------------------------- React 胶水 */

const subscribeStore = (listener: () => void): (() => void) => traceStore.subscribe(listener);
const getVersionSnapshot = (): number => traceStore.getVersion();
const getStatusSnapshot = (): StreamStatus => traceStore.getStatus();
const getResyncSnapshot = (): number => traceStore.getResyncCount();

/** 事件版本号：每收到一条 SSE 事件 +1（徽标 debounce 重取、列表/树重算的触发器）。 */
export function useTraceStreamRevision(): number {
  return useSyncExternalStore(subscribeStore, getVersionSnapshot, getVersionSnapshot);
}

/**
 * 事件驱动的防抖重取（票面：徽标 total 只在收到事件后 debounce 重取，禁轮询）。
 * 返回的 tick 在「事件洪峰静默 debounceMs 后」+1；首帧不排期（调用方的挂载
 * effect 已取过一次，避免启动时双请求）。定时器在下次事件/卸载时清掉——
 * 只保留最后一次，持续事件流不会每 200ms 打一枪。
 */
export function useDebouncedStreamTick(debounceMs: number): number {
  const revision = useTraceStreamRevision();
  const [tick, setTick] = useState(0);
  const timer = useRef<number | undefined>(undefined);
  const firstRun = useRef(true);

  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false; // 挂载：不排期（mount effect 自带首次取数）
      return;
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setTick((t) => t + 1), debounceMs);
    return () => window.clearTimeout(timer.current);
  }, [revision, debounceMs]);

  return tick;
}

export function useTraceStreamStatus(): StreamStatus {
  return useSyncExternalStore(subscribeStore, getStatusSnapshot, getStatusSnapshot);
}

/** 重连成功次数：变化即表示「浏览器刚续传过」，页面应重取一次 REST 兜底。 */
export function useTraceStreamResyncCount(): number {
  return useSyncExternalStore(subscribeStore, getResyncSnapshot, getResyncSnapshot);
}

export function useLiveTraceRows(): ReadonlyMap<string, LiveTraceRow> {
  const version = useTraceStreamRevision();
  // version 只作重算触发器：maps 是可变对象，靠它把快照钉在「本版事件之后」。
  return useMemo(() => traceStore.getLiveRows(), [version]);
}

export function useTraceDetailView(traceId: string): TraceDetailView {
  const version = useTraceStreamRevision();
  // 重连成功也要重取：断线期间服务若换库，续传会被旧游标整段跳过（见 ensureConnected 注），
  // REST 是唯一能补出真实终态的通道。
  const resyncCount = useTraceStreamResyncCount();
  useEffect(() => {
    traceStore.requestTraceDetail(traceId);
  }, [traceId, resyncCount]);
  return useMemo(() => traceStore.getDetailView(traceId), [traceId, version]);
}
