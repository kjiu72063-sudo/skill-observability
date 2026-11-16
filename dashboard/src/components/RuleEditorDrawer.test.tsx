import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ApiError } from "../api/client";
import type { Rule } from "../api/rules";
import RuleEditorDrawer from "./RuleEditorDrawer";

const existing: Rule = { id: "edit-rule", name: "编辑项", category: "pii", action: "audit", enabled: false, priority: 22, agent_ids: ["support"], tool_names: ["query_user"], args_regex: { pattern: "\\d{4}", flags: "im", fields: ["phone"] }, description: "原说明", created_at_unix_nano: "1760000000000000001", updated_at_unix_nano: "1760000000000000002" };
afterEach(() => { cleanup(); });

describe("RuleEditorDrawer", () => {
  it("serializes all editable fields, arrays and args_regex shape", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined); const onClose = vi.fn();
    render(<RuleEditorDrawer rule={null} onClose={onClose} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText("规则 ID"), { target: { value: "new-rule" } });
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "新规则" } });
    fireEvent.change(screen.getByLabelText("类别"), { target: { value: "tool_denylist" } });
    fireEvent.change(screen.getByLabelText("动作"), { target: { value: "audit" } });
    fireEvent.change(screen.getByLabelText("优先级"), { target: { value: "17" } });
    fireEvent.change(screen.getByLabelText("作用域 agent_ids"), { target: { value: "ops, support" } });
    fireEvent.change(screen.getByLabelText("工具名 tool_names"), { target: { value: "run_shell" } });
    fireEvent.change(screen.getByLabelText("pattern"), { target: { value: "rm\\s+-rf" } });
    fireEvent.click(screen.getByLabelText("m"));
    fireEvent.change(screen.getByLabelText("fields"), { target: { value: "command, script" } });
    fireEvent.change(screen.getByLabelText("说明"), { target: { value: "新说明" } });
    fireEvent.click(screen.getByLabelText("启用"));
    fireEvent.click(screen.getByRole("button", { name: "保存规则" }));
    expect(await onSave).toHaveBeenCalledWith({ id: "new-rule", name: "新规则", category: "tool_denylist", action: "audit", enabled: false, priority: 17, agent_ids: ["ops", "support"], tool_names: ["run_shell"], args_regex: { pattern: "rm\\s+-rf", flags: "im", fields: ["command", "script"] }, description: "新说明" }, false);
  });

  it("loads edit fields, locks id, and preserves input after 422", async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new ApiError(422, "args_regex.pattern cannot be compiled"));
    render(<RuleEditorDrawer rule={existing} onClose={vi.fn()} onSave={onSave} />);
    expect(screen.getByLabelText("规则 ID")).toHaveValue("edit-rule");
    expect(screen.getByLabelText("规则 ID")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("pattern")).toHaveValue("\\d{4}");
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "保留名称" } });
    fireEvent.click(screen.getByRole("button", { name: "保存规则" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("HTTP 422");
    expect(screen.getByRole("alert")).toHaveTextContent("args_regex.pattern cannot be compiled");
    expect(screen.getByLabelText("名称")).toHaveValue("保留名称");
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ id: "edit-rule", category: "pii", action: "audit", enabled: false, priority: 22, agent_ids: ["support"], tool_names: ["query_user"], args_regex: { pattern: "\\d{4}", flags: "im", fields: ["phone"] }, description: "原说明" }), true);
  });

  it("Escape and cancel close without submitting", () => {
    const onSave = vi.fn(); const onClose = vi.fn();
    render(<RuleEditorDrawer rule={null} onClose={onClose} onSave={onSave} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onSave).not.toHaveBeenCalled();
  });
});
