import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import StatsPage from "./Stats";

const rule = {
  id: "r1",
  name: "客户身份证号外泄",
  category: "pii",
  action: "block",
  enabled: true,
  priority: 10,
  agent_ids: null,
  tool_names: ["search_customer"],
  args_regex: null,
  description: null,
  created_at_unix_nano: "1794389455893772000",
  updated_at_unix_nano: "1794389455893772000",
};

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

function cardValue(id: string): HTMLElement {
  return screen.getByTestId(id).querySelector(".stat-card-value") as HTMLElement;
}

function stubStats(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const bodies: Record<string, unknown> = {
    "/api/traces?page_size=1": { total: 137 },
    "/api/traces?live=true&page_size=1": { total: 2 },
    "/api/audits?page_size=1": { total: 8 },
    "/api/audits?verdict=block&page_size=1": { total: 2 },
    "/api/audits?action=audit&page_size=1": { total: 3 },
    "/api/audits/stats/by-rule?limit=1": {
      items: [{ rule_id: "r1", rule_name: "客户身份证号外泄", action: "block", verdict_block_hits: 2, verdict_audit_hits: 0, hits: 2 }],
      total: 1,
    },
    "/api/rules": { items: [rule, { ...rule, id: "r2", enabled: false }, { ...rule, id: "r3", enabled: true }] },
    ...overrides,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      calls.push(url);
      return Promise.resolve(response(bodies[url] ?? { detail: "unexpected URL" }, bodies[url] ? 200 : 500));
    })
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("StatsPage", () => {
  it("渲染三组八卡并映射真实 API 值", async () => {
    const calls = stubStats();
    render(<StatsPage />);

    expect(screen.getByRole("heading", { name: "01 调用链" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "02 拦截" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "03 规则" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("stat-card-1")).toHaveTextContent("137"));
    expect(cardValue("stat-card-2")).toHaveTextContent(/^2$/);
    expect(cardValue("stat-card-3")).toHaveTextContent(/^8$/);
    expect(cardValue("stat-card-4")).toHaveTextContent(/^2$/);
    expect(cardValue("stat-card-5")).toHaveTextContent(/^3$/);
    expect(cardValue("stat-card-6")).toHaveTextContent(/^25.0%$/);
    expect(screen.getByTestId("stat-card-7")).toHaveTextContent("客户身份证号外泄");
    expect(screen.getByTestId("stat-card-7")).toHaveTextContent("2 hits");
    expect(cardValue("stat-card-8")).toHaveTextContent(/^2$/);
    expect(calls).toHaveLength(7);
  });

  it("单张请求失败时只标记该卡，页面和其它卡仍可用", async () => {
    const bodies: Record<string, unknown> = {
      "/api/traces?page_size=1": { total: 137 },
      "/api/traces?live=true&page_size=1": { total: 2 },
      "/api/audits?page_size=1": { total: 8 },
      "/api/audits?action=audit&page_size=1": { total: 3 },
      "/api/audits/stats/by-rule?limit=1": { items: [], total: 0 },
      "/api/rules": { items: [rule] },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === "/api/audits?verdict=block&page_size=1") return Promise.resolve(response({ detail: "boom" }, 500));
        return Promise.resolve(response(bodies[url]));
      })
    );
    render(<StatsPage />);
    await waitFor(() => expect(screen.getByTestId("stat-card-1")).toHaveTextContent("137"));
    expect(cardValue("stat-card-4")).toHaveTextContent(/^—$/);
    expect(screen.getByTestId("stat-card-4")).toHaveTextContent("API 500: boom");
    expect(screen.getByTestId("stat-card-7")).toHaveTextContent("暂无命中");
  });

  it("分母为 0 显示破折号，Top 规则无命中显示暂无命中，启用规则只计 enabled", async () => {
    stubStats({
      "/api/traces?page_size=1": { total: 0 },
      "/api/traces?live=true&page_size=1": { total: 0 },
      "/api/audits?page_size=1": { total: 0 },
      "/api/audits?verdict=block&page_size=1": { total: 0 },
      "/api/audits?action=audit&page_size=1": { total: 0 },
      "/api/audits/stats/by-rule?limit=1": { items: [], total: 0 },
      "/api/rules": { items: [rule, { ...rule, id: "disabled", enabled: false }] },
    });
    render(<StatsPage />);
    await waitFor(() => expect(cardValue("stat-card-3")).toHaveTextContent(/^0$/));
    expect(cardValue("stat-card-6")).toHaveTextContent(/^—$/);
    expect(screen.getByTestId("stat-card-7")).toHaveTextContent("暂无命中");
    expect(cardValue("stat-card-8")).toHaveTextContent(/^1$/);
  });
});
