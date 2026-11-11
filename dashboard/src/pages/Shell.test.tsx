/**
 * 壳页冒烟（M2-02 #17）：挂载点在场、标题占位文本正确、无业务区块内容。
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import Shell from "./Shell";

describe("Shell 壳页（M2-02）", () => {
  it("渲染标题占位与挂载点，不含导航与业务数据", () => {
    render(<Shell />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("SIGIL");
    // 边界：无导航（无 nav 元素）、无列表/表格等业务区块
    expect(document.querySelector("nav")).toBeNull();
    expect(document.querySelector("table")).toBeNull();
  });
});
