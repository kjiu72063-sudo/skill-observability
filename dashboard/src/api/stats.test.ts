import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchAuditTotal,
  fetchBlockedAuditTotal,
  fetchLiveTraceTotal,
  fetchObservedAuditTotal,
  fetchRuleStats,
  fetchTopRule,
  fetchTraceTotal,
} from "./stats";

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("统计端点 URL 与形状守卫", () => {
  it("逐项使用契约固定的 URL 和参数", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        calls.push(url);
        if (url.includes("stats/by-rule")) return Promise.resolve(response({ items: [], total: 0 }));
        return Promise.resolve(response({ total: 3 }));
      })
    );

    await fetchTraceTotal();
    await fetchLiveTraceTotal();
    await fetchAuditTotal();
    await fetchBlockedAuditTotal();
    await fetchObservedAuditTotal();
    await fetchTopRule();

    expect(calls).toEqual([
      "/api/traces?page_size=1",
      "/api/traces?live=true&page_size=1",
      "/api/audits?page_size=1",
      "/api/audits?verdict=block&page_size=1",
      "/api/audits?action=audit&page_size=1",
      "/api/audits/stats/by-rule?limit=1",
    ]);
  });

  it("拒绝缺失或非法的 total", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ items: [] })));
    await expect(fetchTraceTotal()).rejects.toThrow(/缺少合法 total/);
  });

  it("拒绝非法的 by-rule 响应，空 items 返回 null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ items: [{ hits: 1 }], total: 1 })));
    await expect(fetchRuleStats()).rejects.toThrow(/by-rule 缺少合法 items\/total/);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ items: [], total: 0 })));
    await expect(fetchTopRule()).resolves.toBeNull();
  });

  it("保留共享请求层的单请求失败", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ detail: "service unavailable" }, 503)));
    await expect(fetchLiveTraceTotal()).rejects.toMatchObject({ status: 503, detail: "service unavailable" });
  });

  it("保留 by-rule 首项的规则名和 hits", async () => {
    const top = {
      rule_id: "r1",
      rule_name: "客户身份证号外泄",
      action: "block",
      verdict_block_hits: 4,
      verdict_audit_hits: 0,
      hits: 4,
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ items: [top], total: 1 })));
    await expect(fetchTopRule()).resolves.toEqual(top);
  });
});
