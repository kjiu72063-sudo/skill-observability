import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import StatCard from "./StatCard";

afterEach(cleanup);

describe("StatCard", () => {
  it("统一渲染标题、值、副文案和可访问名称", () => {
    render(
      <StatCard
        id="stat-card-1"
        title="Trace 总数"
        description="root span 行数（含进行中）"
        status="ready"
        value={137}
      />
    );
    expect(screen.getByRole("article", { name: "Trace 总数" })).toHaveTextContent("137");
    expect(screen.getByText("root span 行数（含进行中）")).toBeInTheDocument();
  });

  it("支持 loading、error、empty 三种非正常态", () => {
    const { rerender } = render(
      <StatCard id="stat-card-1" title="Trace 总数" description="说明" status="loading" />
    );
    expect(screen.getByText("加载中…")).toBeInTheDocument();

    rerender(
      <StatCard id="stat-card-1" title="Trace 总数" description="说明" status="error" errorMessage="读取失败" />
    );
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByText("读取失败")).toBeInTheDocument();

    rerender(
      <StatCard id="stat-card-1" title="Trace 总数" description="说明" status="empty" emptyValue="暂无命中" />
    );
    expect(screen.getByText("暂无命中")).toBeInTheDocument();
  });
});
