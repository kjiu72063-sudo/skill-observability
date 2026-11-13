/**
 * SSE 传输层（M2-06 #21）：`GET /api/events` 的 EventSource 封装。
 *
 * - 事件名按契约 trace §3.1（`span.start` / `span.end`）；`id:` 的续传语义交给
 *   浏览器原生 `Last-Event-ID`（重连由 EventSource 自身负责，不做自研重连）。
 * - `event.data` 一律走 `parseLossless`（纳秒以字符串进组件树，禁 `JSON.parse`）——
 *   与 REST 基座 `client.ts` 同一条精度纪律；单条脏事件不打断整条流。
 * - 本模块只管「开一条流 + 分发事件」，连接的生命周期（单例、常驻）在
 *   `traceStore`：离开 Trace 页不断流，侧栏徽标继续长。
 */

import { parseLossless } from "../api/losslessJson";

/** 契约 trace §3.2 的两个事件名。 */
export type SpanEventKind = "span.start" | "span.end";

export interface SpanStreamHandlers {
  onEvent: (kind: SpanEventKind, data: unknown) => void;
  onStatus: (status: "open" | "error") => void;
}

/** 一条已打开的流；`close` 只在真正的销毁路径（如测试）使用。 */
export interface SpanStream {
  close: () => void;
}

/** EventSource 的最小形状：浏览器原生实例满足，测试可注入假实现（jsdom 无 EventSource）。 */
export interface EventSourceLike {
  addEventListener: (type: string, listener: (event: Event) => void) => void;
  close: () => void;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

export const SSE_PATH = "/api/events";

/**
 * 浏览器原生 EventSource 工厂；jsdom / 非浏览器环境不存在时返回 null，
 * 状态层据此降级为纯 REST 快照（测试环境不产生网络副作用）。
 */
export const browserEventSourceFactory: EventSourceFactory | null =
  typeof EventSource === "function" ? (url) => new EventSource(url) : null;

/** `event.data`（SSE 文本）→ 无损解析后的对象；非字符串/坏 JSON 由调用方兜住。 */
function parseEventData(event: Event): unknown {
  const data = (event as MessageEvent<unknown>).data;
  if (typeof data !== "string") throw new Error("SSE data 不是字符串");
  return parseLossless(data);
}

/**
 * 打开 `/api/events` 并绑定两个事件名。
 * 返回 null = 当前环境没有 EventSource（jsdom 单测 / SSR），调用方保持 REST 模式。
 */
export function openSpanStream(
  handlers: SpanStreamHandlers,
  factory: EventSourceFactory | null = browserEventSourceFactory
): SpanStream | null {
  if (factory === null) return null;
  const source = factory(SSE_PATH);

  const listen = (kind: SpanEventKind): void => {
    source.addEventListener(kind, (event) => {
      let data: unknown;
      try {
        data = parseEventData(event);
      } catch {
        return; // 单条脏事件（非 JSON 等）丢弃，下一事件继续
      }
      handlers.onEvent(kind, data);
    });
  };
  listen("span.start");
  listen("span.end");

  source.onopen = () => handlers.onStatus("open");
  // 浏览器原生会在 onerror 后自动重连；这里只上报状态给页面黄条，不关闭、不自研重连。
  source.onerror = () => handlers.onStatus("error");

  return { close: () => source.close() };
}
