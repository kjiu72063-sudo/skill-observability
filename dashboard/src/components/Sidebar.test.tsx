/**
 * 侧边栏徽标映射冒烟（M2-03 #18）：四项导航的徽标语义各就各位。
 *
 * #25：Trace/审计/规则徽标接真数据，统计无徽标。
 * mock fetch 到 /api 层（useNavTotals 走真实 client），组件树全真渲染。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { HashRouter } from "react-router-dom";

import Sidebar from "./Sidebar";

// vitest 未开 globals（vite.config 本票禁改），RTL 自动 cleanup 不生效——显式清
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderSidebar() {
  return render(
    <HashRouter>
      <Sidebar />
    </HashRouter>
  );
}

describe("Sidebar 徽标映射（M2-03 #18）", () => {
  it("Trace/审计徽标接真数据（fetch total）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        const totals: Record<string, unknown> = { "/api/traces?page_size=1": { items: [], page: 1, page_size: 1, total: 7 }, "/api/audits?page_size=1": { items: [], page: 1, page_size: 1, total: 12 }, "/api/rules": { items: [] } };
        const body = totals[url];
        if (body === undefined) return Promise.reject(new Error("unexpected url: " + url));
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify(body)),
        });
      })
    );
    renderSidebar();
    await screen.findByText("7");
    expect(screen.getByText("12")).toBeInTheDocument();
  });

  it("规则徽标显示规则总数，统计卡片无徽标", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (url === "/api/rules") {
        const rule = (id: string, enabled: boolean) => ({ id, name: id, category: "custom", action: "block", enabled, priority: 1, agent_ids: null, tool_names: ["tool"], args_regex: null, description: null, created_at_unix_nano: "1", updated_at_unix_nano: "2" });
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ items: [rule("r1", true), rule("r2", false)] })) });
      }
      if (url === "/api/traces?page_size=1" || url === "/api/audits?page_size=1") return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ items: [], page: 1, page_size: 1, total: 1 })) });
      return Promise.reject(new Error("unexpected url: " + url));
    }));
    renderSidebar();
    const rules = screen.getByRole("link", { name: /规则管理/ });
    await screen.findByText("2");
    expect(rules).toHaveTextContent("2");
    // 统计卡片链接内无任何徽标文本（不含数字、不含占位符）
    const stats = screen.getByRole("link", { name: /统计卡片/ });
    expect(stats).not.toHaveTextContent("—");
    expect(stats.textContent).toBe("统计卡片");
  });

  it("取数失败时徽标落「—」而非闪 0/卡加载态", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve(JSON.stringify({ detail: "boom" })) })
      )
    );
    renderSidebar();
    const trace = screen.getByRole("link", { name: /Trace/ });
    await vi.waitFor(() => expect(trace).toHaveTextContent("—"));
    expect(screen.getByRole("link", { name: /规则管理/ })).toHaveTextContent("—");
  });

  it("规则 API 明确返回空列表时显示 0；加载中不闪 0", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (url === "/api/rules") return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ items: [] })) });
      return new Promise(() => {});
    }));
    const { unmount } = renderSidebar();
    const rules = screen.getByRole("link", { name: /规则管理/ });
    expect(rules.querySelector(".rail-num")).toBeNull();
    unmount();
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(url === "/api/rules" ? { items: [] } : { items: [], page: 1, page_size: 1, total: 0 })) })));
    renderSidebar();
    await vi.waitFor(() =>
      expect(screen.getByRole("link", { name: /规则管理/ })).toHaveTextContent("0")
    );
  });
});
