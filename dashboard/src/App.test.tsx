/**
 * 看板壳导航与路由冒烟（M2-03 #18）：左侧边栏 4 项 + HashRouter 四路由。
 *
 * 路由方案定为 HashRouter：demo.py 的 StaticFiles(html=True) 无 SPA fallback
 * （GET /trace → 404，实测），而 demo.py 在禁改清单——BrowserRouter 的
 * 「刷新后落在原区块」在 demo 路径下物理不可能达成。/#/trace 刷新即落位，
 * 后端零改动。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import Shell from "./pages/Shell";

function renderShellAtHash(hash: string) {
  window.location.hash = hash;
  render(<Shell />);
}

// vitest 未开 globals（vite.config 本票禁改），RTL 自动 cleanup 不生效——显式清
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("看板壳导航（M2-03 #18）", () => {
  it("侧边栏四项导航齐全，默认路由落在 /trace", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.reject(new Error("no fetch in this test")))
    );
    renderShellAtHash("");
    expect(screen.getByRole("navigation")).toBeInTheDocument();
    for (const label of ["Trace", "审计日志", "规则管理", "统计卡片"]) {
      expect(screen.getByRole("link", { name: new RegExp(label) })).toBeInTheDocument();
    }
    // 默认落在 Trace 占位页（Navigate to /trace）
    expect(window.location.hash).toBe("#/trace");
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Trace");
  });

  it("点击导航 URL 随路由变化，占位页显示区块名", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.reject(new Error("no fetch in this test")))
    );
    renderShellAtHash("");
    fireEvent.click(screen.getByRole("link", { name: /审计日志/ }));
    expect(window.location.hash).toBe("#/audit");
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("审计日志");
    fireEvent.click(screen.getByRole("link", { name: /规则管理/ }));
    expect(window.location.hash).toBe("#/rules");
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("规则管理");
    fireEvent.click(screen.getByRole("link", { name: /统计卡片/ }));
    expect(window.location.hash).toBe("#/stats");
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("统计卡片");
  });

  it("直接以 #/audit 打开（模拟刷新落位），落在审计占位页且选中态正确", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.reject(new Error("no fetch in this test")))
    );
    renderShellAtHash("#/audit");
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("审计日志");
    const auditLink = screen.getByRole("link", { name: /审计日志/ });
    expect(auditLink).toHaveAttribute("aria-current", "page");
    const traceLink = screen.getByRole("link", { name: /Trace/ });
    expect(traceLink).not.toHaveAttribute("aria-current");
  });

  it("未知路由重定向回 /trace（静态托管无 404 页，兜底落位）", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.reject(new Error("no fetch in this test")))
    );
    renderShellAtHash("#/nope");
    expect(window.location.hash).toBe("#/trace");
  });
});
