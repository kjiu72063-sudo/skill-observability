/**
 * 审计取数层单测（M2-07 #22）：段 → 查询参数映射与响应形状守卫。
 *
 * 这层是「口径唯一出自服务端」的唯一映射点（票面边界）——映射写错不会让页面报错，
 * 只会静默查出另一个集合，所以每条映射都单独钉住。
 */

import { describe, expect, it } from "vitest";

import {
  AUDIT_PAGE_SIZE,
  auditQuery,
  fetchAudits,
  formatAuditTime,
  verdictTone,
} from "./audits";

describe("auditQuery（筛选段 → 契约参数）", () => {
  it("全部 → 不带任何筛选参数", () => {
    expect(auditQuery("all")).toEqual({});
  });

  it("拦截 → verdict=block", () => {
    expect(auditQuery("block")).toEqual({ verdict: "block" });
  });

  it("放行 → verdict=allow（含观察期命中行，不在前端排除）", () => {
    expect(auditQuery("allow")).toEqual({ verdict: "allow" });
  });

  it("观察期 → 只发 action=audit，不额外补 verdict（AND 语义归服务端契约）", () => {
    expect(auditQuery("observe")).toEqual({ action: "audit" });
  });
});

describe("verdictTone（三徽标分档）", () => {
  it("verdict=block → 拦截（红）", () => {
    expect(verdictTone({ verdict: "block", action: "block" })).toBe("block");
  });

  it("verdict=allow + action=audit → 观察期命中（琥珀）", () => {
    expect(verdictTone({ verdict: "allow", action: "audit" })).toBe("observe");
  });

  it("verdict=allow + 未命中（action=null）→ 放行（灰）", () => {
    expect(verdictTone({ verdict: "allow", action: null })).toBe("allow");
  });
});

describe("fetchAudits（URL 拼装与形状守卫）", () => {
  function stubFetch(raw: string, status = 200) {
    const calls: string[] = [];
    const fn = (url: string) => {
      calls.push(url);
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        text: () => Promise.resolve(raw),
      });
    };
    return { calls, fn };
  }

  it("四段各自拼出契约参数的 URL（观察期走 action=audit）", async () => {
    const { calls, fn } = stubFetch(`{"items":[],"page":1,"page_size":20,"total":0}`);
    globalThis.fetch = fn as unknown as typeof fetch;

    await fetchAudits(1, "all");
    await fetchAudits(1, "block");
    await fetchAudits(1, "allow");
    await fetchAudits(1, "observe");

    expect(calls).toEqual([
      `/api/audits?page=1&page_size=${AUDIT_PAGE_SIZE}`,
      `/api/audits?page=1&page_size=${AUDIT_PAGE_SIZE}&verdict=block`,
      `/api/audits?page=1&page_size=${AUDIT_PAGE_SIZE}&verdict=allow`,
      `/api/audits?page=1&page_size=${AUDIT_PAGE_SIZE}&action=audit`,
    ]);
  });

  it("响应缺 items/total → 抛普通 Error（不是 ApiError）", async () => {
    globalThis.fetch = stubFetch(`{"page":1}`).fn as unknown as typeof fetch;
    await expect(fetchAudits(1, "all")).rejects.toThrow(/响应形状异常/);
  });

  it("纳秒字段字符串承载（losslessJson 基座生效）", async () => {
    globalThis.fetch = stubFetch(
      `{"items":[{"id":1,"trace_id":"t","span_id":"s","agent_id":"a","tool_name":"q",` +
        `"verdict":"allow","rule_id":null,"rule_name":null,"action":null,"reason":null,` +
        `"payload_truncated":false,"created_at_unix_nano":1794389455893772000}],` +
        `"page":1,"page_size":20,"total":1}`
    ).fn as unknown as typeof fetch;

    const body = await fetchAudits(1, "all");
    expect(body.items[0].created_at_unix_nano).toBe("1794389455893772000");
  });
});

describe("formatAuditTime", () => {
  it("纳秒字符串 → MM-DD HH:MM:SS.mmm", () => {
    const d = new Date(Number(1794389455893772000n / 1_000_000n));
    const p = (n: number, w = 2) => String(n).padStart(w, "0");
    const expected =
      `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:` +
      `${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
    expect(formatAuditTime("1794389455893772000")).toBe(expected);
  });

  it("非法输入 → 「—」，不抛", () => {
    expect(formatAuditTime("not-a-number")).toBe("—");
  });
});
