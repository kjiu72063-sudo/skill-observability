/**
 * 侧边栏徽标映射冒烟（M2-03 #18）：四项导航的徽标语义各就各位。
 *
 * #2 定案：Trace/审计徽标接真数据、规则徽标「—」占位、统计无徽标。
 * mock fetch 到 /api 层（useNavTotals 走真实 client），组件树全真渲染。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { HashRouter } from "react-router-dom";

import Sidebar from "./Sidebar";

function mockApi(body: Record<string, unknown>, path: string) {
  return vi.fn().mockImplementation((url: string) => {
    if (url === `/api/${path}?page_size=1`) {
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) });
    }
    return Promise.reject(new Error(`unexpected url: ${url}`));
  });
}

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
        const totals: Record<string, number> = { "/api/traces?page_size=1": 7, "/api/audits?page_size=1": 12 };
        const total = totals[url];
        if (total === undefined) return Promise.reject(new Error(`unexpected url: ${url}`));
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({ items: [], page: 1, page_size: 1, total })),
        });
      })
    );
    renderSidebar();
    await screen.findByText("7");
    expect(screen.getByText("12")).toBeInTheDocument();
  });

  it("规则徽标恒为「—」占位，统计卡片无徽标", async () => {
    vi.stubGlobal("fetch", mockApi({ items: [], page: 1, page_size: 1, total: 1 }, "traces"));
    renderSidebar();
    // 规则管理链接内含「—」
    const rules = screen.getByRole("link", { name: /规则管理/ });
    expect(rules).toHaveTextContent("—");
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
  });
});
