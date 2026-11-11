/**
 * 徽标取数封装冒烟（M2-03 #18）：?page_size=1 取 total 的两个封装函数。
 *
 * fetch mock 返回原始 JSON 文本——客户端基座先取 text 再 parseLossless，
 * total 是普通小整数不受纳秒改写影响，但路径必须走真实基座（勿 mock parseLossless）。
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchTraceTotal, fetchAuditTotal } from "./client";

function mockOk(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("徽标 total 取数（M2-03 #18）", () => {
  it("fetchTraceTotal 请求 /traces?page_size=1 并返回 total", async () => {
    const fetchMock = mockOk({ items: [], page: 1, page_size: 1, total: 137 });
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchTraceTotal()).resolves.toBe(137);
    expect(fetchMock).toHaveBeenCalledWith("/api/traces?page_size=1", { signal: undefined });
  });

  it("fetchAuditTotal 请求 /audits?page_size=1（全量口径，不带筛选）并返回 total", async () => {
    const fetchMock = mockOk({ items: [], page: 1, page_size: 1, total: 12 });
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchAuditTotal()).resolves.toBe(12);
    expect(fetchMock).toHaveBeenCalledWith("/api/audits?page_size=1", { signal: undefined });
  });

  it("纳秒字段字符串承载进组件树，total 不受无损改写影响（走真实基座）", async () => {
    // 线路形状按 #2 决议：纳秒 >2^53 由后端以 JSON 字符串下发（19 位 number 字面量
    // 在 JS 解析时已静默失真，2^53≈9.0e15 < 1.79e18）——fixture 用字符串，
    // 并断言 parseLossless 对已是字符串的纳秒值原样保串。
    const body = {
      items: [{ trace_id: "abc", start_time_unix_nano: "1794389455893772000" }],
      page: 1,
      page_size: 1,
      total: 2,
    };
    vi.stubGlobal("fetch", mockOk(body));
    const parsed = (await import("./losslessJson")).parseLossless(JSON.stringify(body)) as {
      items: Array<{ start_time_unix_nano: string }>;
    };
    expect(parsed.items[0].start_time_unix_nano).toBe("1794389455893772000");
    await expect(fetchTraceTotal()).resolves.toBe(2);
  });

  it("total 缺失或非数字（形状守卫）→ 拒绝，徽标层 catch 落「—」", async () => {
    vi.stubGlobal("fetch", mockOk({ items: [], page: 1, page_size: 1 }));
    await expect(fetchTraceTotal()).rejects.toThrow("total 缺失或非数字（/traces?page_size=1）");
  });

  it("非 2xx 抛 ApiError（status + detail，形状同基座约定）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve(JSON.stringify({ detail: "boom" })),
      })
    );
    await expect(fetchTraceTotal()).rejects.toMatchObject({
      name: "ApiError",
      status: 500,
      detail: "boom",
    });
  });
});
