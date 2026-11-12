/**
 * Trace 列表取数与格式化单测（M2-04 #19）。
 *
 * 锚点（票面验收）：
 * - 请求形状 = 契约 §2.1（page/page_size，OFFSET 翻页）
 * - 响应经 losslessJson 基座：纳秒字符串原样进组件树（禁裸 .json()）
 * - 排序在前提做，用 BigInt 精确比较（2^53 以上相邻时间 Number 比较会判等）
 * - 时间格式化 HH:MM:SS.mmm；进行中判定 = end_time_unix_nano === null
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchTraces,
  formatNanoTime,
  formatTraceDate,
  isInProgress,
  sortTraceItemsDesc,
  TRACE_PAGE_SIZE,
  fetchTraceDetail,
  type TraceListItem,
} from "./traces";

afterEach(() => vi.unstubAllGlobals());

function mockOk(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

function item(overrides: Partial<TraceListItem> = {}): TraceListItem {
  return {
    trace_id: "t1",
    name: "invoke_agent customer-service",
    agent_id: "customer-service",
    start_time_unix_nano: "1794389455893772000",
    end_time_unix_nano: "1794389456024277000",
    status_code: "UNSET",
    span_count: 7,
    blocked: true,
    ...overrides,
  };
}

describe("fetchTraces（契约 §2.1）", () => {
  it("请求 /api/traces?page=N&page_size=20 并原样返回分页体", async () => {
    const fetchMock = mockOk({ items: [item()], page: 2, page_size: 20, total: 137 });
    vi.stubGlobal("fetch", fetchMock);

    const body = await fetchTraces(2);

    expect(fetchMock).toHaveBeenCalledWith("/api/traces?page=2&page_size=20", { signal: undefined });
    expect(body.page).toBe(2);
    expect(body.total).toBe(137);
    expect(body.items).toHaveLength(1);
  });

  it("默认页大小 = 20（契约默认值）", () => {
    expect(TRACE_PAGE_SIZE).toBe(20);
  });

  it("纳秒字段以字符串进组件树（走真实 losslessJson 基座，不裸 .json()）", async () => {
    // 线路形状必须是 19 位**数字字面量**（FastAPI 原样序列化 int）；
    // 若用 JSON.stringify 传字符串，parseLossless 的数字改写路径根本没被走到（假绿）。
    const wire =
      '{"items":[{"trace_id":"t1","name":"invoke_agent","agent_id":"a",' +
      '"start_time_unix_nano":1794389455893772000,"end_time_unix_nano":1794389456024277000,' +
      '"status_code":"UNSET","span_count":7,"blocked":true}],' +
      '"page":1,"page_size":20,"total":1}';
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve(wire) })
    );

    const body = await fetchTraces(1);

    expect(typeof body.items[0].start_time_unix_nano).toBe("string");
    expect(body.items[0].start_time_unix_nano).toBe("1794389455893772000");
    expect(typeof body.items[0].end_time_unix_nano).toBe("string");
    // 未经 base 64 之类中转的原始精度：末位 000 之后的 001 也能保住（下面单独用例覆盖）
    expect(body.items[0].end_time_unix_nano).toBe("1794389456024277000");
  });

  it("相邻纳秒只差 1 也能无损保留（Number 化会判等）", async () => {
    const wire =
      '{"items":[{"start_time_unix_nano":1794389455893772001,"end_time_unix_nano":null}],' +
      '"page":1,"page_size":20,"total":1}';
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve(wire) })
    );
    const body = await fetchTraces(1);
    expect(body.items[0].start_time_unix_nano).toBe("1794389455893772001");
    expect(BigInt(body.items[0].start_time_unix_nano)).toBe(1794389455893772001n);
  });

  it("end_time_unix_nano 为 null 时原样保留（进行中语义的线路形状）", async () => {
    vi.stubGlobal(
      "fetch",
      mockOk({ items: [item({ end_time_unix_nano: null })], page: 1, page_size: 20, total: 1 })
    );
    const body = await fetchTraces(1);
    expect(body.items[0].end_time_unix_nano).toBeNull();
  });

  it("形状守卫：缺 items/total → 拒绝（普通 Error，不装 ApiError）", async () => {
    vi.stubGlobal("fetch", mockOk({ page: 1, page_size: 20 }));
    await expect(fetchTraces(1)).rejects.toThrow("GET /api/traces 响应形状异常");
  });

  it("非 2xx 抛 ApiError（baseURL 与错误形状走基座）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: () => Promise.resolve(JSON.stringify({ detail: "db locked" })),
      })
    );
    await expect(fetchTraces(1)).rejects.toMatchObject({
      name: "ApiError",
      status: 503,
      detail: "db locked",
    });
  });
});

describe("sortTraceItemsDesc（前端排序，BigInt 比较）", () => {
  it("按 root start 倒序", () => {
    const sorted = sortTraceItemsDesc([
      item({ trace_id: "old", start_time_unix_nano: "1794389455000000000" }),
      item({ trace_id: "new", start_time_unix_nano: "1794389455893772000" }),
      item({ trace_id: "mid", start_time_unix_nano: "1794389455600000000" }),
    ]);
    expect(sorted.map((i) => i.trace_id)).toEqual(["new", "mid", "old"]);
  });

  it("2^53 以上相邻纳秒仍能正确区分（Number 比较会判等的用例）", () => {
    // 1794389455893772001 vs 1794389455893772000：Number 化后相等，BigInt 不等
    const sorted = sortTraceItemsDesc([
      item({ trace_id: "a", start_time_unix_nano: "1794389455893772000" }),
      item({ trace_id: "b", start_time_unix_nano: "1794389455893772001" }),
    ]);
    expect(sorted.map((i) => i.trace_id)).toEqual(["b", "a"]);
  });

  it("不修改入参（纯函数）", () => {
    const input = [
      item({ trace_id: "a", start_time_unix_nano: "1" }),
      item({ trace_id: "b", start_time_unix_nano: "2" }),
    ];
    sortTraceItemsDesc(input);
    expect(input.map((i) => i.trace_id)).toEqual(["a", "b"]);
  });
});

describe("时间格式化（纳秒字符串 → HH:MM:SS.mmm，本地时区）", () => {
  it("17 位毫秒级纳秒转出 HH:MM:SS.mmm", () => {
    // 用 Date 反推期望值，避免测试机时区差异
    const d = new Date(2026, 10, 10, 9, 59, 58, 222);
    const nano = `${BigInt(d.getTime()) * 1_000_000n}`;
    expect(formatNanoTime(nano)).toBe("09:59:58.222");
  });

  it("毫秒补零到 3 位（009 不塌缩成 9）", () => {
    const d = new Date(2026, 10, 10, 1, 2, 3, 9);
    const nano = `${BigInt(d.getTime()) * 1_000_000n}`;
    expect(formatNanoTime(nano)).toBe("01:02:03.009");
  });

  it("19 位纳秒精度不丢（末三位毫秒可辨）", () => {
    // 1794389455893772001 ns → 毫秒 1794389455893，亚毫秒被截断（展示粒度毫秒）
    const d = new Date(Number(1794389455893772001n / 1_000_000n));
    const expected =
      `${String(d.getHours()).padStart(2, "0")}:` +
      `${String(d.getMinutes()).padStart(2, "0")}:` +
      `${String(d.getSeconds()).padStart(2, "0")}.` +
      `${String(d.getMilliseconds()).padStart(3, "0")}`;
    expect(formatNanoTime("1794389455893772001")).toBe(expected);
  });

  it("非法输入返回「—」不抛（null/空串/非数字）", () => {
    expect(formatNanoTime(null)).toBe("—");
    expect(formatNanoTime(undefined)).toBe("—");
    expect(formatNanoTime("")).toBe("—");
    expect(formatNanoTime("12ab")).toBe("—");
  });

  it("formatTraceDate 输出 MM-DD（列表行日期维度）", () => {
    const d = new Date(2026, 10, 10, 9, 59, 58, 222);
    const nano = `${BigInt(d.getTime()) * 1_000_000n}`;
    expect(formatTraceDate(nano)).toBe("11-10");
    expect(formatTraceDate(null)).toBe("—");
  });
});

describe("isInProgress（契约语义：root end_time_unix_nano 为 null）", () => {
  it("end 为 null → true", () => {
    expect(isInProgress({ end_time_unix_nano: null })).toBe(true);
  });

  it("end 有值 → false（不回退到前端计时器）", () => {
    expect(isInProgress({ end_time_unix_nano: "1794389456024277000" })).toBe(false);
  });
});

describe("fetchTraceDetail（契约 §2.2 详情：平铺 spans）", () => {
  it("请求 GET /api/traces/{id} 并返回平铺数组（未递归）", async () => {
    const fetchMock = mockOk({
      trace_id: "t/1",
      spans: [
        { trace_id: "t/1", span_id: "a", parent_span_id: null, name: "invoke_agent x", kind: "INTERNAL", start_time_unix_nano: "1", end_time_unix_nano: null, status_code: "UNSET", status_message: null, attributes: {}, events: [], agent_id: null },
        { trace_id: "t/1", span_id: "b", parent_span_id: "a", name: "chat x", kind: "CLIENT", start_time_unix_nano: "2", end_time_unix_nano: "3", status_code: "UNSET", status_message: null, attributes: {}, events: [], agent_id: null },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    const body = await fetchTraceDetail("t/1");

    // trace_id 必须编码进 path（防注入/特殊字符）
    expect(fetchMock).toHaveBeenCalledWith("/api/traces/t%2F1", { signal: undefined });
    expect(body.spans).toHaveLength(2);
    expect(body.spans[1].parent_span_id).toBe("a");
  });

  it("真实线路形状：纳秒数字字面量经 losslessJson 变字符串，不做递归分组", async () => {
    const wire =
      '{"trace_id":"t1","spans":[' +
      '{"trace_id":"t1","span_id":"a","parent_span_id":null,"name":"invoke_agent",' +
      '"kind":"INTERNAL","start_time_unix_nano":1794473008218267400,' +
      '"end_time_unix_nano":1794473008370309100,"status_code":"UNSET","status_message":null,' +
      '"attributes":{},"events":[],"agent_id":null}]}';
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve(wire) })
    );

    const body = await fetchTraceDetail("t1");
    const span = body.spans[0];

    expect(typeof span.start_time_unix_nano).toBe("string");
    expect(span.start_time_unix_nano).toBe("1794473008218267400");
    expect(typeof span.end_time_unix_nano).toBe("string");
    // 子节点没有被塞进父节点（平铺即契约）
    expect(span).not.toHaveProperty("children");
  });

  it("响应缺 spans → 抛普通 Error（形状守卫，不是 HTTP 错误）", async () => {
    vi.stubGlobal("fetch", mockOk({ trace_id: "t1" }));
    await expect(fetchTraceDetail("t1")).rejects.toThrow(/响应形状异常/);
  });

  it("404 → ApiError（status=404），调用方据此区分「trace 不存在」", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve('{"detail":"trace not found"}'),
      })
    );
    await expect(fetchTraceDetail("nope")).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
      detail: "trace not found",
    });
  });
});
