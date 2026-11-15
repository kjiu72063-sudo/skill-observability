import { describe, expect, it } from "vitest";

import {
  auditBaseLocation,
  auditLocation,
  parseAuditLocation,
  parseTraceLocation,
  traceBaseLocation,
  traceLocation,
} from "./urlState";

describe("trace URL 状态", () => {
  it("构造并解析 trace 定位目标", () => {
    const id = "4bf92f3577b34da6a3ce929d0e0e4736";
    expect(traceLocation(id)).toBe(`/trace?trace=${id}`);
    expect(parseTraceLocation(`?trace=${id}`)).toBe(id);
    expect(traceBaseLocation()).toBe("/trace");
  });

  it("构造时使用标准 URL 编码", () => {
    expect(traceLocation("trace /?&=+")).toBe("/trace?trace=trace+%2F%3F%26%3D%2B");
  });

  it("拒绝缺失、重复或非 32 位小写十六进制 trace_id", () => {
    expect(parseTraceLocation("")).toBeNull();
    expect(parseTraceLocation("?trace=abc")).toBeNull();
    expect(parseTraceLocation("?trace=4BF92F3577B34DA6A3CE929D0E0E4736")).toBeNull();
    expect(parseTraceLocation("?trace=a&trace=b")).toBeNull();
  });
});

describe("audit URL 状态", () => {
  it("构造并解析展开的审计定位目标", () => {
    expect(auditLocation(23)).toBe("/audit?audit=23&expanded=1");
    expect(parseAuditLocation("?audit=23&expanded=1")).toBe(23);
    expect(auditBaseLocation()).toBe("/audit");
  });

  it("拒绝非法 audit_id", () => {
    for (const value of ["", "0", "-1", "1.5", "01", "abc", "9007199254740992"]) {
      expect(parseAuditLocation(`?audit=${encodeURIComponent(value)}&expanded=1`)).toBeNull();
    }
  });

  it("缺少参数或 expanded 不是 1 时不恢复展开态", () => {
    expect(parseAuditLocation("")).toBeNull();
    expect(parseAuditLocation("?audit=23")).toBeNull();
    expect(parseAuditLocation("?expanded=1")).toBeNull();
    expect(parseAuditLocation("?audit=23&expanded=0")).toBeNull();
    expect(parseAuditLocation("?audit=23&expanded=true")).toBeNull();
    expect(parseAuditLocation("?audit=23&audit=24&expanded=1")).toBeNull();
    expect(parseAuditLocation("?audit=23&expanded=1&expanded=1")).toBeNull();
  });
});
