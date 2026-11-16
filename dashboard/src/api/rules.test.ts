import { afterEach, describe, expect, it, vi } from "vitest";

import { createRule, deleteRule, fetchRules, replaceRule, type Rule } from "./rules";

const rule: Rule = {
  id: "test-rule-01", name: "测试规则", category: "custom", action: "block", enabled: true, priority: 12,
  agent_ids: null, tool_names: ["run_shell"], args_regex: { pattern: "rm\\s+-rf", flags: "im", fields: ["command"] },
  description: null, created_at_unix_nano: "1760000000000000001", updated_at_unix_nano: "1760000000000000002",
};
const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => body === undefined ? "" : JSON.stringify(body) });
afterEach(() => { vi.unstubAllGlobals(); });

describe("rules API", () => {
  it("GET returns all complete items and retains nanosecond timestamps as strings", async () => {
    const fetch = vi.fn().mockResolvedValue(response({ items: [rule] })); vi.stubGlobal("fetch", fetch);
    await expect(fetchRules()).resolves.toEqual([rule]);
    expect(fetch).toHaveBeenCalledWith("/api/rules", { signal: undefined });
  });

  it("rejects malformed list and rule response shapes", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(response({})).mockResolvedValueOnce(response({ items: [{ id: "incomplete" }] }));
    vi.stubGlobal("fetch", mockFetch);
    await expect(fetchRules()).rejects.toThrow("缺少 items");
    await expect(fetchRules()).rejects.toThrow("非法规则对象");
  });

  it("uses POST, PUT full replacement, and DELETE with contract paths and statuses", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(rule, 201)).mockResolvedValueOnce(response(rule)).mockResolvedValueOnce(response(undefined, 204));
    vi.stubGlobal("fetch", fetch);
    await createRule({ id: rule.id, name: rule.name, category: rule.category, action: rule.action, enabled: rule.enabled, priority: rule.priority, agent_ids: rule.agent_ids, tool_names: rule.tool_names, args_regex: rule.args_regex, description: rule.description });
    await replaceRule(rule);
    await deleteRule(rule.id);
    expect(fetch.mock.calls.map(([url, init]) => [url, init?.method ?? "GET"])).toEqual([
      ["/api/rules", "POST"], ["/api/rules/test-rule-01", "PUT"], ["/api/rules/test-rule-01", "DELETE"],
    ]);
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toEqual(rule);
  });

  it("preserves status and detail from 409 and 422 responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response({ detail: "rule id already exists" }, 409)).mockResolvedValueOnce(response({ detail: "args_regex.pattern cannot be compiled" }, 422)));
    await expect(createRule(rule)).rejects.toMatchObject({ status: 409, detail: "rule id already exists" });
    await expect(replaceRule(rule)).rejects.toMatchObject({ status: 422, detail: "args_regex.pattern cannot be compiled" });
  });
});
