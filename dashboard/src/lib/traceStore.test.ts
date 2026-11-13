/**
 * 实时状态层单测（M2-06 #21）：合并语义是本票的判定核心，全部用纯函数 + Store 双路覆盖。
 *
 * 四例（票面规定）：
 * ① start→end 正常生长 ② REST 已有 + 回放 start 不重复 ③ end 覆盖 start ④ 重复事件幂等。
 * 另加：跨事件类型乱序（旧 start 不降级终态）、列表第 1 页增量、单连接/常驻、详情合并。
 *
 * 线路形状：payload 以**原始 JSON 文本**喂给 sse 的解析路径（纳秒数字字面量），
 * 确保 losslessJson 改写真的被执行（#19 立过的锚点，避免假绿）；纯函数例直接给对象。
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseLossless } from "../api/losslessJson";
import type { TraceListItem, TraceSpan } from "../api/traces";
import {
  applySpanEnd,
  applySpanStart,
  mergeLiveTraceList,
  mergeSpans,
  normalizeSpanPayload,
  traceStore,
  TraceStore,
  useTraceDetailView,
  type LiveTraceRow,
} from "./traceStore";
import type { EventSourceFactory, EventSourceLike } from "./sse";

/* ---------------------------------------------------------------- 线路形状 fixture */

/** 一条 span.start 的原始 JSON（纳秒数字字面量，与 FastAPI 序列化一致）。 */
function startWire(fields: {
  trace_id?: string;
  span_id: string;
  parent_span_id?: string | null;
  name?: string;
  start?: string;
}): string {
  const {
    trace_id = "4bf92f3577b34da6a3ce929d0e0e4736",
    span_id,
    parent_span_id = "b7ad6b7169203331",
    name = `span ${span_id}`,
    start = "1794389455893772000",
  } = fields;
  return (
    `{"trace_id":"${trace_id}","span_id":"${span_id}",` +
    `"parent_span_id":${parent_span_id === null ? "null" : `"${parent_span_id}"`},` +
    `"name":"${name}","kind":"INTERNAL","start_time_unix_nano":${start},` +
    `"agent_id":"customer-service"}`
  );
}

/** 一条 span.end 的原始 JSON（整行快照）。 */
function endWire(fields: {
  trace_id?: string;
  span_id: string;
  parent_span_id?: string | null;
  name?: string;
  start?: string;
  end?: string;
  status_code?: string;
  status_message?: string | null;
  attributes?: string;
  events?: string;
}): string {
  const {
    trace_id = "4bf92f3577b34da6a3ce929d0e0e4736",
    span_id,
    parent_span_id = "b7ad6b7169203331",
    name = `span ${span_id}`,
    start = "1794389455893772000",
    end = "1794389456024277000",
    status_code = "UNSET",
    status_message = null,
    attributes = "{}",
    events = "[]",
  } = fields;
  return (
    `{"trace_id":"${trace_id}","span_id":"${span_id}",` +
    `"parent_span_id":${parent_span_id === null ? "null" : `"${parent_span_id}"`},` +
    `"name":"${name}","kind":"INTERNAL","start_time_unix_nano":${start},` +
    `"end_time_unix_nano":${end},"status_code":"${status_code}",` +
    `"status_message":${status_message === null ? "null" : `"${status_message}"`},` +
    `"attributes":${attributes},"events":${events},"agent_id":"customer-service"}`
  );
}

/** 走真实 SSE 解析路径：JSON 文本 → parseLossless（= sse.ts 做的那一步）。 */
function feed(store: TraceStore, kind: "span.start" | "span.end", wire: string): void {
  store.dispatch(kind, parseLossless(wire));
}

/** REST 详情侧的 span 对象（已解析；纳秒字符串）。 */
function restSpan(fields: Partial<TraceSpan> & { span_id: string }): TraceSpan {
  return {
    trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
    parent_span_id: null,
    name: `span ${fields.span_id}`,
    kind: "INTERNAL",
    start_time_unix_nano: "1794389455893772000",
    end_time_unix_nano: null,
    status_code: "UNSET",
    status_message: null,
    attributes: {},
    events: [],
    agent_id: "customer-service",
    ...fields,
  };
}

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";

/* ---------------------------------------------------------------- 合并语义四例 */

describe("合并语义（#21 票面四例）", () => {
  it("① start → end 正常生长：进行中节点补时长/状态，字段无 undefined", () => {
    const store = new TraceStore(null);
    feed(store, "span.start", startWire({ span_id: "aaaa000000000001" }));

    const running = store.getLiveSpans(TRACE)?.get("aaaa000000000001");
    expect(running).toBeDefined();
    // span.start 缺的四个字段在合并层补默认，绝不 undefined 漏进组件
    expect(running).toMatchObject({
      end_time_unix_nano: null,
      status_code: "UNSET",
      attributes: {},
      events: [],
    });
    expect(running).not.toHaveProperty("end_time_unix_nano", undefined);

    feed(
      store,
      "span.end",
      endWire({
        span_id: "aaaa000000000001",
        end: "1794389456000000000",
        attributes: '{"skill_observability.verdict":"block"}',
      })
    );

    const grown = store.getLiveSpans(TRACE)?.get("aaaa000000000001");
    expect(grown?.end_time_unix_nano).toBe("1794389456000000000");
    expect(grown?.attributes).toEqual({ "skill_observability.verdict": "block" });
    // 纳秒全程字符串（parseLossless 改写生效，不是 number）
    expect(typeof grown?.start_time_unix_nano).toBe("string");
    expect(typeof grown?.end_time_unix_nano).toBe("string");
  });

  it("② REST 已有 + 回放 start 不重复：同 span_id 只有一条，且终态不被降级", () => {
    const done = restSpan({
      span_id: "aaaa000000000001",
      end_time_unix_nano: "1794389456000000000",
      status_code: "UNSET",
      attributes: { "gen_ai.tool.name": "query_user_db" },
    });
    const live = new Map<string, TraceSpan>();
    // 首连全量回放：先到的 start 是旧快照（end 为 null）
    live.set("aaaa000000000001", normalizeSpanPayload("span.start", parseLossless(startWire({ span_id: "aaaa000000000001" })))!);

    const merged = mergeSpans([done], live);
    expect(merged).toHaveLength(1);
    expect(merged[0].end_time_unix_nano).toBe("1794389456000000000");
    expect(merged[0].status_code).toBe("UNSET");
    // REST 的更全 attributes 不被最小 start 冲掉
    expect(merged[0].attributes).toEqual({ "gen_ai.tool.name": "query_user_db" });
  });

  it("③ end 覆盖 start：整行快照全量覆盖，键集合与 end 完全一致", () => {
    const start = normalizeSpanPayload("span.start", {
      trace_id: TRACE,
      span_id: "aaaa000000000001",
      parent_span_id: null,
      name: "old name",
      kind: "INTERNAL",
      start_time_unix_nano: "1794389455893772000",
      agent_id: "customer-service",
    })!;
    const end = normalizeSpanPayload("span.end", {
      trace_id: TRACE,
      span_id: "aaaa000000000001",
      parent_span_id: null,
      name: "new name",
      kind: "CLIENT",
      start_time_unix_nano: "1794389455893772000",
      end_time_unix_nano: "1794389456024277000",
      status_code: "ERROR",
      status_message: "boom",
      attributes: { "error.type": "policy.block" },
      events: [{ name: "exception" }],
      agent_id: "customer-service",
    })!;

    // 给 start 侧注入一个 end 快照里**完全不存在**的顶层键（类型系统外的脏数据）：
    // 整行替换会把它丢掉；`{...existing, ...incoming}` 这种浅合并会把它留下。
    // 这是本条用例的鉴别力所在——只断言 attributes 里的键做不到（incoming.attributes
    // 整体覆盖，spread-merge 也能过，评审第二拍 N2 的 mutation 就卡在这里）。
    const withStartOnly = {
      ...start,
      stale_top_level_key: "must-not-survive",
    } as unknown as typeof start;
    const grown = applySpanEnd(withStartOnly, end);

    expect(Object.keys(grown).sort()).toEqual(Object.keys(end).sort());
    expect(grown).not.toHaveProperty("stale_top_level_key");
    // 值字段：end 的快照说了算
    expect(grown.name).toBe("new name");
    expect(grown.kind).toBe("CLIENT");
    expect(grown.status_code).toBe("ERROR");
    expect(grown.status_message).toBe("boom");
    expect(grown.attributes).toEqual({ "error.type": "policy.block" });
    expect(grown.events).toHaveLength(1);
    // end 快照里 attributes 为空也要覆盖成空（不是保留 start 的）
    expect(applySpanEnd(withStartOnly, { ...end, attributes: {} }).attributes).toEqual({});
  });

  it("④ 重复事件幂等：同一 start 两次、同一 end 两次，结果与一次相同", () => {
    const store = new TraceStore(null);
    const start = startWire({ span_id: "aaaa000000000001" });
    const end = endWire({ span_id: "aaaa000000000001", status_code: "ERROR" });

    feed(store, "span.start", start);
    const once = store.getLiveSpans(TRACE)?.get("aaaa000000000001");
    feed(store, "span.start", start);
    expect(store.getLiveSpans(TRACE)?.get("aaaa000000000001")).toEqual(once);
    expect(store.getLiveSpans(TRACE)?.size).toBe(1);

    feed(store, "span.end", end);
    const ended = store.getLiveSpans(TRACE)?.get("aaaa000000000001");
    feed(store, "span.end", end);
    expect(store.getLiveSpans(TRACE)?.get("aaaa000000000001")).toEqual(ended);
    expect(store.getLiveSpans(TRACE)?.size).toBe(1);
  });
});

/* ---------------------------------------------------------------- 边界：乱序 / 脏数据 */

describe("合并边界（#21 票面「乱序按 upsert 自然兜底，不特判」）", () => {
  it("旧 start 晚到不把已收口 span 降级回进行中", () => {
    const store = new TraceStore(null);
    feed(store, "span.start", startWire({ span_id: "aaaa000000000001" }));
    feed(store, "span.end", endWire({ span_id: "aaaa000000000001" }));
    feed(store, "span.start", startWire({ span_id: "aaaa000000000001" }));

    const span = store.getLiveSpans(TRACE)?.get("aaaa000000000001");
    expect(span?.end_time_unix_nano).toBe("1794389456024277000");
  });

  it("进行中的 REST 快照 + 更新的 start 合并：保留 REST 的更全 attributes", () => {
    const rest = restSpan({
      span_id: "aaaa000000000001",
      attributes: { "gen_ai.operation.name": "execute_tool" },
    });
    const start = normalizeSpanPayload("span.start", {
      trace_id: TRACE,
      span_id: "aaaa000000000001",
      parent_span_id: null,
      name: "span aaaa000000000001",
      kind: "INTERNAL",
      start_time_unix_nano: "1794389455893772000",
      agent_id: "customer-service",
    })!;
    const merged = applySpanStart(rest, start);
    expect(merged.attributes).toEqual({ "gen_ai.operation.name": "execute_tool" });
    expect(merged.end_time_unix_nano).toBeNull();
  });

  it("脏事件（缺 span_id / 非对象）丢弃，不打断后续事件", () => {
    const store = new TraceStore(null);
    store.dispatch("span.start", { trace_id: TRACE, name: "无 span_id" });
    store.dispatch("span.start", null);
    store.dispatch("span.start", "not an object");
    expect(store.getLiveSpans(TRACE)).toBeUndefined();

    feed(store, "span.start", startWire({ span_id: "aaaa000000000001" }));
    expect(store.getLiveSpans(TRACE)?.size).toBe(1);
  });

  it("normalizeSpanPayload：end=null 的 statics 字段补齐；缺关键字段返回 null", () => {
    const span = normalizeSpanPayload("span.start", parseLossless(startWire({ span_id: "aaaa000000000001" })));
    expect(span).toMatchObject({ end_time_unix_nano: null, status_code: "UNSET", events: [] });
    expect(normalizeSpanPayload("span.end", { name: "x" })).toBeNull();
  });
});

/* ---------------------------------------------------------------- 列表增量（第 1 页） */

function restItem(traceId: string, start: string): TraceListItem {
  return {
    trace_id: traceId,
    name: "invoke_agent customer-service",
    agent_id: "customer-service",
    start_time_unix_nano: start,
    end_time_unix_nano: start,
    status_code: "UNSET",
    span_count: 7,
    blocked: false,
  };
}

function liveRow(traceId: string, start: string, extra: Partial<LiveTraceRow> = {}): LiveTraceRow {
  return {
    trace_id: traceId,
    name: "invoke_agent customer-service",
    agent_id: "customer-service",
    start_time_unix_nano: start,
    end_time_unix_nano: null,
    status_code: "UNSET",
    span_count: 1,
    blocked: false,
    ...extra,
  };
}

describe("列表增量合并（只作用第 1 页）", () => {
  it("新 trace 行插到顶部；已有行按 SSE 补 span 数 / 收口 / 拦截", () => {
    const items = [restItem("old", "1794389455000000000")];
    const live = new Map([
      ["old", liveRow("old", "1794389455000000000", { span_count: 7, end_time_unix_nano: "1794389456024277000", blocked: true })],
      ["new", liveRow("new", "1794389457000000000")],
    ]);
    const merged = mergeLiveTraceList(items, live, 20);

    expect(merged.items.map((i) => i.trace_id)).toEqual(["new", "old"]);
    expect(merged.inserted).toBe(1);
    const old = merged.items[1];
    expect(old.span_count).toBe(7);
    expect(old.end_time_unix_nano).toBe("1794389456024277000");
    expect(old.blocked).toBe(true);
  });

  it("满页时只有更新的行属于第 1 页；更老的插进来也不许出现", () => {
    // 20 行，最老 start = 1000；新行必须比「本页最新一行」更新（=2000）
    const items = Array.from({ length: 20 }, (_, i) =>
      restItem(`t${i}`, String(2000 - i * 10))
    );
    const live = new Map([
      ["newer", liveRow("newer", "9999")],
      ["older", liveRow("older", "1")],
      ["middle", liveRow("middle", "1500")], // 比最老行新、但比最新行旧 → 属于后面的页
    ]);
    const merged = mergeLiveTraceList(items, live, 20);

    expect(merged.items.map((i) => i.trace_id)).not.toContain("older");
    expect(merged.items.map((i) => i.trace_id)).not.toContain("middle");
    expect(merged.items[0].trace_id).toBe("newer");
    expect(merged.inserted).toBe(1);
    // 截断到一页：插入后总数仍是 20（最老一行被挤出本页）
    expect(merged.items).toHaveLength(20);
    expect(merged.items.at(-1)?.trace_id).not.toBe("t19");
  });

  it("空列表 + 全新 trace：单行插入，inserted=1", () => {
    const merged = mergeLiveTraceList([], new Map([["a", liveRow("a", "1")]]), 20);
    expect(merged.items.map((i) => i.trace_id)).toEqual(["a"]);
    expect(merged.inserted).toBe(1);
  });

  it("服务端换库（旧实时行全部比 REST 最新行更老）→ 不诈尸", () => {
    // 前提：重连时 resetForResync 已清空旧 live（否则空库场景无基准线可依，见下一例）
    const items = [restItem("fresh", "9000")];
    const live = new Map([
      ["stale1", liveRow("stale1", "100", { span_count: 7 })],
      ["stale2", liveRow("stale2", "200", { span_count: 7 })],
      ["fresh", liveRow("fresh", "9000", { span_count: 3 })],
    ]);
    const merged = mergeLiveTraceList(items, live, 20);
    expect(merged.items.map((i) => i.trace_id)).toEqual(["fresh"]);
    expect(merged.inserted).toBe(0);
  });

  it("空快照 + 残留 live 行：mergeLiveTraceList 会全放行（故剔除必须靠 resetForResync）", () => {
    // 这是评审第一拍 P1 的现场：换库后新库为空，watermark 无基准线。
    // 单看这个纯函数，它会给出幽灵行——所以「剔除旧数据」不是它的职责，
    // 由 Store.resetForResync 在换代瞬间整段清空。此用例把这条契约钉死。
    const merged = mergeLiveTraceList(
      [],
      new Map([["old-a", liveRow("old-a", "100")], ["old-b", liveRow("old-b", "200")]]),
      20
    );
    expect(merged.inserted).toBe(2);
  });

  it("首连全量回放的历史 trace 不重复计入 total（只数比快照最新一行更新的）", () => {
    // 快照已有 2 条（total=2）；回放把这两条的历史事件也推来了，外加一条更新的
    const items = [restItem("a", "2000"), restItem("b", "1000")];
    const live = new Map([
      ["a", liveRow("a", "2000", { span_count: 7 })],
      ["b", liveRow("b", "1000", { span_count: 7 })],
      ["new", liveRow("new", "3000")],
    ]);
    const merged = mergeLiveTraceList(items, live, 20);

    // 历史两条：不计数（REST total 已含）；只有 new 是新增
    expect(merged.inserted).toBe(1);
    expect(merged.items).toHaveLength(3);
    expect(merged.items[0].trace_id).toBe("new");
  });
});

/* ---------------------------------------------------------------- 连接生命周期 */

class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  readonly listeners = new Map<string, Array<(event: Event) => void>>();
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close(): void {
    this.closed = true;
  }

  /** 模拟服务端推一条事件（data 是 SSE 文本原文）。 */
  emit(type: string, data: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new MessageEvent(type, { data }));
    }
  }
}

const fakeFactory: EventSourceFactory = (url) => new FakeEventSource(url);

describe("连接生命周期（单连接 / 常驻 / 续传依赖浏览器原生）", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("StrictMode 双挂载（订阅两次 + 退订一次）仍然只有 1 个 EventSource", () => {
    const store = new TraceStore(fakeFactory);
    const noop = () => {};
    const unsubscribeA = store.subscribe(noop);
    const unsubscribeB = store.subscribe(noop); // StrictMode 第二次挂载
    unsubscribeA(); // StrictMode 卸载（不得关流）
    store.subscribe(noop);

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe("/api/events");
    expect(FakeEventSource.instances[0].closed).toBe(false);
    unsubscribeB();
  });

  it("最后一个订阅者离开也不关流（徽标在别的页面继续长）", () => {
    const store = new TraceStore(fakeFactory);
    const unsubscribe = store.subscribe(() => {});
    unsubscribe();
    expect(FakeEventSource.instances[0].closed).toBe(false);
  });

  it("SSE 原文经 parseLossless 进状态层：纳秒是字符串，事件能驱动列表行", () => {
    const store = new TraceStore(fakeFactory);
    store.subscribe(() => {});
    const source = FakeEventSource.instances[0];

    source.emit("span.start", startWire({ span_id: "aaaa000000000001", parent_span_id: null }));
    source.emit("span.end", endWire({ span_id: "aaaa000000000001", parent_span_id: null, status_code: "ERROR", attributes: '{"skill_observability.verdict":"block"}' }));

    const rows = store.getLiveRows();
    const row = rows.get(TRACE);
    expect(row).toBeDefined();
    expect(row?.end_time_unix_nano).toBe("1794389456024277000");
    expect(typeof row?.start_time_unix_nano).toBe("string");
    expect(row?.blocked).toBe(true);
    expect(row?.span_count).toBe(1);
  });

  it("status：open/error 双向切换只在变化时通知；无 EventSource 环境恒 static", () => {
    const store = new TraceStore(fakeFactory);
    let notified = 0;
    store.subscribe(() => notified++);
    const source = FakeEventSource.instances[0];
    expect(store.getStatus()).toBe("connecting");

    source.onopen?.(new Event("open"));
    expect(store.getStatus()).toBe("open");
    const afterOpen = notified;
    source.onopen?.(new Event("open")); // 重复 open 不通知
    expect(notified).toBe(afterOpen);

    source.onerror?.(new Event("error"));
    expect(store.getStatus()).toBe("error");
    expect(notified).toBeGreaterThan(afterOpen);

    expect(new TraceStore(null).getStatus()).toBe("static");
  });

  it("重连计数只在 error → open 时 +1（首连 open 不算）", () => {
    const store = new TraceStore(fakeFactory);
    store.subscribe(() => {});
    const source = FakeEventSource.instances[0];
    expect(store.getResyncCount()).toBe(0);

    source.onopen?.(new Event("open")); // 首次连接
    expect(store.getResyncCount()).toBe(0);

    source.onerror?.(new Event("error"));
    source.onopen?.(new Event("open")); // 断线后自动重连成功
    expect(store.getResyncCount()).toBe(1);

    source.onerror?.(new Event("error"));
    source.onopen?.(new Event("open"));
    expect(store.getResyncCount()).toBe(2);
  });
});

/* ---------------------------------------------------------------- 重连换库（评审第一拍 P1） */

describe("重连换库：旧数据源状态必须整段作废（P1 修复回归）", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
  });

  /** 造一个「旧库里有一条已收口 trace」的 Store。 */
  function seedOldDatabase(store: TraceStore): void {
    feed(
      store,
      "span.start",
      startWire({ trace_id: "old-trace", span_id: "old-root", parent_span_id: null })
    );
    feed(
      store,
      "span.end",
      endWire({ trace_id: "old-trace", span_id: "old-root", parent_span_id: null })
    );
  }

  it("换库重连后 live 行清零 → 列表无幽灵行、inserted 不为幽灵数（PROBE_A 回归）", () => {
    const store = new TraceStore(fakeFactory);
    store.subscribe(() => {});
    seedOldDatabase(store);
    expect([...store.getLiveRows().keys()]).toEqual(["old-trace"]);

    const source = FakeEventSource.instances[0];
    source.onerror?.(new Event("error"));
    source.onopen?.(new Event("open")); // 重连成功 → resetForResync

    // 换库后 REST 还没有数据（新库空）：旧行必须已经不在
    expect([...store.getLiveRows().keys()]).toEqual([]);
    const merged = mergeLiveTraceList([], store.getLiveRows(), 20);
    expect(merged.items).toEqual([]);
    expect(merged.inserted).toBe(0);
  });

  it("换库重连后 live span 清零 → 详情无幽灵树（PROBE_B 回归）", () => {
    const store = new TraceStore(fakeFactory);
    store.subscribe(() => {});
    seedOldDatabase(store);
    expect(store.getDetailView("old-trace").kind).toBe("ready"); // 点开能看到旧树

    const source = FakeEventSource.instances[0];
    source.onerror?.(new Event("error"));
    source.onopen?.(new Event("open"));

    // 新库里没有这条 trace：不能再拿旧 live 数据冒充 ready
    expect(store.getDetailView("old-trace").kind).not.toBe("ready");
  });

  it("换库重连后 REST 404 + 旧 live 残留 → 错误态不被让位（PROBE_B 的直接断言）", () => {
    const store = new TraceStore(fakeFactory);
    store.subscribe(() => {});
    seedOldDatabase(store);
    const source = FakeEventSource.instances[0];
    source.onerror?.(new Event("error"));
    source.onopen?.(new Event("open"));

    // 模拟重取后拿到 404
    const internal = store as unknown as {
      restDetails: Map<string, { kind: "error"; message: string }>;
    };
    internal.restDetails.set("old-trace", { kind: "error", message: "trace 不存在" });
    const view = store.getDetailView("old-trace");
    expect(view.kind).toBe("error");
  });

  it("换代前发出的 REST 响应晚到也不写回（世代守卫）", async () => {
    const store = new TraceStore(null); // 无 SSE，直接测请求路径
    let resolveOld: ((v: unknown) => void) | undefined;
    const fetchMock = vi.fn().mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    store.requestTraceDetail("t1"); // 发起旧世代请求
    store.resetForResync(); // 换代
    resolveOld?.({
      ok: true,
      status: 200,
      text: () => Promise.resolve(`{"trace_id":"t1","spans":[]}`),
    });
    await Promise.resolve();
    await Promise.resolve();

    // 旧响应不得写回：换代后还没重新请求，详情应为 loading 而非 ready
    expect(store.getDetailView("t1").kind).toBe("loading");
    vi.unstubAllGlobals();
  });

  it("resetForResync 取消在飞请求（AbortController 生效）", () => {
    const store = new TraceStore(null);
    const abortSpy = vi.fn();
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init?: { signal?: AbortSignal }) => {
        if (init?.signal) signals.push(init.signal);
        return new Promise(() => {}); // 永不 resolve：模拟在飞
      })
    );

    store.requestTraceDetail("t1");
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(false);

    store.resetForResync();
    expect(signals[0].aborted).toBe(true);
    void abortSpy;
    vi.unstubAllGlobals();
  });

  it("force 重取会取消在飞的旧请求（不留悬挂请求）", () => {
    const store = new TraceStore(null);
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init?: { signal?: AbortSignal }) => {
        if (init?.signal) signals.push(init.signal);
        return new Promise(() => {});
      })
    );

    store.requestTraceDetail("t1");
    // 未 force 的重复请求被 pendingDetails 去重（StrictMode 双挂载只发一次）——不是取消
    store.requestTraceDetail("t1");
    expect(signals).toHaveLength(1);

    // force（重试 / 重连重同步）穿透去重，并取消旧请求
    store.requestTraceDetail("t1", true);
    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    vi.unstubAllGlobals();
  });

  it("快速切换 trace A→B→C：每条旧请求都被取消（评审第二拍 N1 回归）", () => {
    const store = new TraceStore(null);
    const signals: Array<{ url: string; signal: AbortSignal }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init?: { signal?: AbortSignal }) => {
        if (init?.signal) signals.push({ url, signal: init.signal });
        return new Promise(() => {}); // 全部挂起，模拟慢网络
      })
    );

    store.requestTraceDetail("A");
    store.requestTraceDetail("B");
    store.requestTraceDetail("C");

    expect(signals.map((s) => s.url)).toEqual(["/api/traces/A", "/api/traces/B", "/api/traces/C"]);
    // 第一版按 traceId 建键时这里全是 false（A/B 永远命中不了自己的 key）——
    // 那是评审第二拍 N1 的现场。正确语义：只看一条，切走即取消。
    expect(signals[0].signal.aborted).toBe(true);
    expect(signals[1].signal.aborted).toBe(true);
    expect(signals[2].signal.aborted).toBe(false);
    vi.unstubAllGlobals();
  });

  it("组件卸载（releaseTraceDetail）取消自己的请求，且不误伤新 trace", () => {
    const store = new TraceStore(null);
    const signals: Array<{ url: string; signal: AbortSignal }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init?: { signal?: AbortSignal }) => {
        if (init?.signal) signals.push({ url, signal: init.signal });
        return new Promise(() => {});
      })
    );

    store.requestTraceDetail("A");
    store.releaseTraceDetail("A"); // A 的 effect cleanup
    expect(signals[0].signal.aborted).toBe(true);

    store.requestTraceDetail("B");
    // A 的迟到 cleanup 不得误伤 B
    store.releaseTraceDetail("A");
    expect(signals[1].signal.aborted).toBe(false);
    vi.unstubAllGlobals();
  });
});

/* ---------------------------------------------------------------- hook 级 force 策略（N4） */

/**
 * 为什么必须 hook 级：N4 是「hook 传 force 的策略」问题，组件级测不出来——
 * 组件里 effect 的 deps 不变时不会重跑，两种 force 实现表现完全一致。
 * 只有直接驱动 hook、并让 `resyncCount` 真的变化，才能区分
 * 「每次重连后只 force 一次」与「重连过一次就永远 force」。
 *
 * N4 的实际危害：force 恒真时 `pendingDetails` 去重分支永久失效——
 * 同一 trace 的重复取数每次都真发请求。
 */
describe("useTraceDetailView 的 force 策略（评审第二拍 N4）", () => {
  /** 记录所有发出的详情请求（挂起不 resolve，保持 in-flight 以观察去重）。 */
  function stubHungFetch(): string[] {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        calls.push(url);
        return new Promise(() => {});
      })
    );
    return calls;
  }

  it("重连令牌未变化时：同一 trace 的重复渲染不产生新请求（force 不粘住）", () => {
    const calls = stubHungFetch();
    const { rerender } = renderHook(({ id }: { id: string }) => useTraceDetailView(id), {
      initialProps: { id: "trace-a" },
    });

    rerender({ id: "trace-a" });
    rerender({ id: "trace-a" });

    expect(calls).toEqual(["/api/traces/trace-a"]);
  });

  it("每次重连只 force 一次，后续同令牌取数重新走去重", () => {
    const calls = stubHungFetch();
    const { rerender } = renderHook(({ id }: { id: string }) => useTraceDetailView(id), {
      initialProps: { id: "trace-b" },
    });
    expect(calls).toHaveLength(1);

    // 重连一次：状态层清空 + 令牌 +1 → hook 必须 force 重取。
    // 只断言「确实重取了」（>1），不断言精确次数：resetForResync 会同时推进
    // version 与 resyncCount，effect 的触发轮次属 React 实现细节，
    // 本用例要守的是「force 语义」而不是「dispatch 的精确次数」。
    act(() => traceStore.resetForResync());
    const afterFirstResync = calls.length;
    expect(afterFirstResync).toBeGreaterThan(1);

    // 同一令牌下再渲染：不得再发（force 只作用于「重连后的首次」）
    rerender({ id: "trace-b" });
    rerender({ id: "trace-b" });
    expect(calls).toHaveLength(afterFirstResync);

    // 再重连一次 → 新令牌 → 又重取
    act(() => traceStore.resetForResync());
    expect(calls.length).toBeGreaterThan(afterFirstResync);
  });
});

/* ---------------------------------------------------------------- 详情视图（REST + SSE） */

/**
 * 这 3 条在第二拍修复时被误删（截断文件时正好切到此处），第三拍评审 D1 要求补回。
 * 它们覆盖 `getDetailView` 的三条分支：REST ready 合并、SSE 先到、REST 错误态让位。
 */
describe("详情视图合并（REST 初值 + 实时）", () => {
  it("REST ready + 实时 end → ready 里同时有 REST 的其它 span 与实时 span", () => {
    const store = new TraceStore(null);
    // 直接铺 REST 终态（模拟 requestTraceDetail 的完成态）
    const internal = store as unknown as {
      restDetails: Map<string, { kind: "ready"; spans: TraceSpan[] }>;
    };
    internal.restDetails.set(TRACE, {
      kind: "ready",
      spans: [restSpan({ span_id: "root000000000000", name: "invoke_agent customer-service" })],
    });

    feed(store, "span.start", startWire({ span_id: "aaaa000000000001", parent_span_id: "root000000000000" }));

    const view = store.getDetailView(TRACE);
    expect(view.kind).toBe("ready");
    if (view.kind !== "ready") throw new Error("unreachable");
    expect(view.spans.map((s) => s.span_id).sort()).toEqual(["aaaa000000000001", "root000000000000"]);
  });

  it("SSE 先到（REST 还没回）也不空等：已有 span 即可 ready", () => {
    const store = new TraceStore(null);
    feed(store, "span.start", startWire({ span_id: "aaaa000000000001", parent_span_id: null }));
    const view = store.getDetailView(TRACE);
    expect(view.kind).toBe("ready");
  });

  it("REST 失败但实时有数据 → ready 让位错误态；无数据时保留错误", () => {
    const store = new TraceStore(null);
    const internal = store as unknown as {
      restDetails: Map<string, { kind: "error"; message: string }>;
    };
    internal.restDetails.set(TRACE, { kind: "error", message: "取数失败（HTTP 500）：boom" });
    expect(store.getDetailView(TRACE).kind).toBe("error");

    feed(store, "span.start", startWire({ span_id: "aaaa000000000001", parent_span_id: null }));
    expect(store.getDetailView(TRACE).kind).toBe("ready");
  });
});
