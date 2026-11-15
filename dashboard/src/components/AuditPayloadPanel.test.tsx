import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import AuditPayloadPanel from "./AuditPayloadPanel";

afterEach(cleanup);

describe("AuditPayloadPanel", () => {
  it("以两空格缩进只读显示格式化 JSON", () => {
    const payload = { user: { id: 7, active: true }, tags: ["a", "b"] };
    const { container } = render(<AuditPayloadPanel payload={payload} truncated={false} />);
    expect(container.querySelector("pre")?.textContent).toBe(JSON.stringify(payload, null, 2));
  });

  it("完整保留嵌套的长键和值", () => {
    const longKey = `nested_${"key".repeat(40)}`;
    const longValue = "value".repeat(100);
    render(<AuditPayloadPanel payload={{ outer: { [longKey]: longValue } }} truncated={false} />);
    const panel = screen.getByRole("region", { name: "审计 payload" });
    expect(panel).toHaveTextContent(longKey);
    expect(panel).toHaveTextContent(longValue);
  });

  it("仅在 payload_truncated=true 时显示已截断", () => {
    const { rerender } = render(<AuditPayloadPanel payload={{ k: "v" }} truncated />);
    expect(screen.getByText("已截断")).toBeInTheDocument();
    rerender(<AuditPayloadPanel payload={{ k: "v" }} truncated={false} />);
    expect(screen.queryByText("已截断")).toBeNull();
  });
});
