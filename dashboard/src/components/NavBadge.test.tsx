/**
 * 徽标组件冒烟（M2-03 #18）：rail-num 计数徽标三态——数字 / 「—」占位 / 加载中。
 *
 * 真实取数在 api 层（client.ts 封装，已有单测）；本组件只管呈现三态，
 * 徽标本身中性色（ink4），红/琥珀/灰三信号色徽标首次使用在 M2-04/M2-07。
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import NavBadge from "../components/NavBadge";

describe("NavBadge 计数徽标（M2-03 #18）", () => {
  it("数字态：渲染真实计数", () => {
    render(<NavBadge value={137} />);
    expect(screen.getByText("137")).toBeInTheDocument();
  });

  it("占位态：value 为 null 显示「—」（规则徽标等 M2-09 CRUD 端点）", () => {
    render(<NavBadge value={null} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("加载态：value 为 undefined 显示空（不闪 0）", () => {
    const { container } = render(<NavBadge value={undefined} />);
    expect(container.textContent).toBe("");
  });
});
