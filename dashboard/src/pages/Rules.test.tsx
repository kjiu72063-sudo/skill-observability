import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import RulesPage from "./Rules";
import type { Rule } from "../api/rules";

const sample = (overrides: Partial<Rule> = {}): Rule => ({ id: "rule-one", name: "危险命令", category: "dangerous_command", action: "block", enabled: true, priority: 10, agent_ids: ["ops"], tool_names: ["run_shell"], args_regex: { pattern: "rm\\s+-rf", flags: "im", fields: ["command"] }, description: "说明", created_at_unix_nano: "1760000000000000001", updated_at_unix_nano: "1760000000000000002", ...overrides });
const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => body === undefined ? "" : JSON.stringify(body) });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("规则管理页面", () => {
  it("显示加载、空列表与 API 失败状态", async () => {
    let finish: ((value: ReturnType<typeof response>) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => new Promise((resolve) => { finish = resolve; })));
    const view = render(<RulesPage />);
    expect(screen.getByRole("status")).toHaveTextContent("正在加载规则");
    finish?.(response({ items: [] }));
    expect(await screen.findByText("暂无规则")).toBeInTheDocument();
    view.unmount();
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => JSON.stringify({ detail: "rules unavailable" }) }));
    render(<RulesPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("请求失败（HTTP 503）：rules unavailable");
  });

  it("按票面顺序展示七列、禁用行及加载/空/错误状态", async () => {
    const rule = sample({ enabled: false });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ items: [rule] })));
    render(<RulesPage />);
    const headers = await screen.findAllByRole("columnheader");
    expect(headers.map((header) => header.textContent)).toEqual(["名称", "类别", "动作", "优先级", "作用域", "匹配条件", "启停"]);
    expect(screen.getByText("rule-one")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "rule-one 启用" })).not.toBeChecked();
  });

  it("toggle 使用完整 PUT 快照，仅改 enabled，成功后重取列表", async () => {
    const original = sample(); const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (!init?.method) return Promise.resolve(response({ items: [original] }));
      const body = JSON.parse(String(init.body)) as Rule;
      return Promise.resolve(response(body));
    }));
    render(<RulesPage />);
    const toggle = await screen.findByRole("checkbox", { name: "rule-one 启用" });
    fireEvent.click(toggle);
    await waitFor(() => expect(calls.filter((call) => call.init?.method === "PUT")).toHaveLength(1));
    const put = calls.find((call) => call.init?.method === "PUT")!;
    expect(put.url).toBe("/api/rules/rule-one");
    const payload = JSON.parse(String(put.init?.body)) as Rule;
    expect(payload).toEqual({ ...original, enabled: false });
    expect(payload.created_at_unix_nano).toBe(original.created_at_unix_nano);
    await waitFor(() => expect(calls.filter((call) => call.url === "/api/rules")).toHaveLength(2));
  });

  it("409 保留输入且不显示成功横幅，合法重试后显示并可关闭", async () => {
    let postCount = 0; let items: Rule[] = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/rules" && !init?.method) return Promise.resolve(response({ items }));
      if (init?.method === "POST" && postCount++ === 0) return Promise.resolve(response({ detail: "rule id already exists" }, 409));
      if (init?.method === "POST") { items = [sample({ id: "new-rule", name: "新建规则" })]; return Promise.resolve(response(items[0], 201)); }
      return Promise.reject(new Error("unexpected request"));
    }));
    render(<RulesPage />);
    fireEvent.click(await screen.findByRole("button", { name: /新建规则/ }));
    fireEvent.change(screen.getByLabelText("规则 ID"), { target: { value: "new-rule" } });
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "新建规则" } });
    fireEvent.change(screen.getByLabelText("工具名 tool_names"), { target: { value: "run_shell" } });
    fireEvent.click(screen.getByRole("button", { name: "保存规则" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("HTTP 409");
    expect(screen.getByRole("alert")).toHaveTextContent("rule id already exists");
    expect(screen.getByLabelText("规则 ID")).toHaveValue("new-rule");
    expect(screen.queryByText(/规则已热生效/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "保存规则" }));
    expect(await screen.findByRole("status")).toHaveTextContent("下一次 evaluate");
    expect(screen.getByRole("status")).toHaveTextContent("进行中的调用不受影响");
    fireEvent.click(screen.getByRole("button", { name: "关闭热生效提示" }));
    expect(screen.queryByText(/规则已热生效/)).toBeNull();
  });

  it("删除确认支持 Escape 取消且确认后发 DELETE", async () => {
    const rule = sample(); const calls: RequestInit[] = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (!init?.method) return Promise.resolve(response({ items: url === "/api/rules" ? [rule] : [] }));
      calls.push(init); return Promise.resolve(response(undefined, 204));
    }));
    render(<RulesPage />);
    fireEvent.click(await screen.findByRole("button", { name: "删除" }));
    expect(screen.getByRole("dialog", { name: "删除规则？" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(calls[0]?.method).toBe("DELETE"));
  });
});
