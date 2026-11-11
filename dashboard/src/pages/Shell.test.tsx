/**
 * 壳页冒烟（M2-03 #18 更新）：顶栏品牌 + 四项导航在场 + 路由出口就绪，无业务区块。
 *
 * #17 版断言「无导航」已过时——M2-03 本票合法加侧边栏（#2 决议 IA 第 1 条）；
 * 标题断言改为品牌文本（原型顶栏 logo 是 span 非 h1，页面级 h2 归各占位页）。
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import Shell from "./Shell";

/** 本用例只验壳结构与占位、不碰数据——reject 掉 fetch，防意外出网。 */
function stubFetchRejected() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(() => Promise.reject(new Error("no fetch in this test")))
  );
}

describe("Shell 壳页（M2-03）", () => {
  it("顶栏品牌 + 侧边栏四项导航 + 路由出口，无业务区块内容", () => {
    // HashRouter 已内置于 Shell（M2-03 收编 main.tsx 越界后），直接渲染
    stubFetchRejected();
    render(<Shell />);
    // 品牌「SIGIL」跨 SIG<b>IL</b> 两元素——用函数匹配器取 textContent
    expect(
      screen.getByText((_, el) => el?.classList.contains("logo") === true && el.textContent === "SIGIL")
    ).toBeInTheDocument();
    expect(screen.getByRole("navigation")).toBeInTheDocument();
    for (const label of ["Trace", "审计日志", "规则管理", "统计卡片"]) {
      expect(screen.getByRole("link", { name: new RegExp(label) })).toBeInTheDocument();
    }
    // 边界：无表格等业务区块（占位页内容由 App.test 验证）
    expect(document.querySelector("table")).toBeNull();
  });
});
