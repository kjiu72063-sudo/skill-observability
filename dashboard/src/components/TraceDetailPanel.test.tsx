/**
 * 详情面板组件测试（M2-05 #20）：真实线路形状 → 三层树 / 徽标 / M5 / M3 / 切换。
 *
 * fixture 全部以**原始 JSON 文本**下发（纳秒是 19 位数字字面量），经真实
 * losslessJson 基座进组件树——若用 JSON.stringify 传字符串，精度的改写路径
 * 根本不会被执行（假绿，#19 已立过同款锚点）。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import TraceDetailPanel from "./TraceDetailPanel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** demo 形状的 span 原始 JSON（7 span，三层；纳秒数字字面量）。 */
const DEMO_SPANS_JSON = `
{"trace_id":"tid","span_id":"root","parent_span_id":null,"name":"invoke_agent customer-service",
 "kind":"INTERNAL","start_time_unix_nano":1794473008218267400,"end_time_unix_nano":1794473008370309100,
 "status_code":"UNSET","status_message":null,
 "attributes":{"gen_ai.operation.name":"invoke_agent","service.name":"customer-service"},
 "events":[],"agent_id":"customer-service"},
{"trace_id":"tid","span_id":"chat1","parent_span_id":"root","name":"chat gpt-4o-mini",
 "kind":"CLIENT","start_time_unix_nano":1794473008222839500,"end_time_unix_nano":1794473008323012700,
 "status_code":"UNSET","status_message":null,
 "attributes":{"gen_ai.operation.name":"chat","gen_ai.request.model":"gpt-4o-mini"},
 "events":[],"agent_id":"customer-service"},
{"trace_id":"tid","span_id":"tool1","parent_span_id":"chat1","name":"execute_tool query_user_db",
 "kind":"INTERNAL","start_time_unix_nano":1794473008313710100,"end_time_unix_nano":1794473008320084800,
 "status_code":"UNSET","status_message":null,
 "attributes":{"gen_ai.operation.name":"execute_tool","gen_ai.tool.name":"query_user_db"},
 "events":[],"agent_id":"customer-service"},
{"trace_id":"tid","span_id":"chat2","parent_span_id":"root","name":"chat gpt-4o-mini",
 "kind":"CLIENT","start_time_unix_nano":1794473008325913200,"end_time_unix_nano":1794473008345820500,
 "status_code":"UNSET","status_message":null,
 "attributes":{"gen_ai.operation.name":"chat"},
 "events":[],"agent_id":"customer-service"},
{"trace_id":"tid","span_id":"tool2","parent_span_id":"chat2","name":"execute_tool query_contact_by_phone",
 "kind":"INTERNAL","start_time_unix_nano":1794473008336875000,"end_time_unix_nano":1794473008342589000,
 "status_code":"UNSET","status_message":null,
 "attributes":{"gen_ai.operation.name":"execute_tool",
   "skill_observability.verdict":"allow","skill_observability.matched_rule":"r1b-pii-phone-audit"},
 "events":[],"agent_id":"customer-service"},
{"trace_id":"tid","span_id":"chat3","parent_span_id":"root","name":"chat gpt-4o-mini",
 "kind":"CLIENT","start_time_unix_nano":1794473008349853500,"end_time_unix_nano":1794473008367241500,
 "status_code":"UNSET","status_message":null,
 "attributes":{"gen_ai.operation.name":"chat"},
 "events":[],"agent_id":"customer-service"},
{"trace_id":"tid","span_id":"tool3","parent_span_id":"chat3","name":"execute_tool verify_customer_id",
 "kind":"INTERNAL","start_time_unix_nano":1794473008359146900,"end_time_unix_nano":1794473008364093900,
 "status_code":"ERROR","status_message":"命中规则 r1-pii-id-card（客户身份证号外泄）：110101199003071234",
 "attributes":{"gen_ai.operation.name":"execute_tool","error.type":"policy.block",
   "skill_observability.verdict":"block","skill_observability.matched_rule":"r1-pii-id-card",
   "skill_observability.block_reason":"命中规则 r1-pii-id-card（客户身份证号外泄）：110101199003071234"},
 "events":[],"agent_id":"customer-service"}`;

function stubDetail(spansJson: string, traceId = "4bf92f3577b34da6a3ce929d0e0e4736") {
  const fetchMock = vi.fn().mockImplementation(() => {
    const body = `{"trace_id":"${traceId}","spans":[${spansJson}]}`;
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(body) });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderPanel(traceId = "4bf92f3577b34da6a3ce929d0e0e4736") {
  return render(<TraceDetailPanel traceId={traceId} />);
}

describe("Trace 详情树（M2-05 #20）", () => {
  it("demo 形状 → 三层树：1 root + 3 chat + 3 execute_tool，父子层级正确", async () => {
    stubDetail(DEMO_SPANS_JSON);
    renderPanel();

    const root = await screen.findByRole("button", { name: /^span invoke_agent customer-service/ });
    expect(root).toHaveAttribute("data-depth", "0");
    expect(root).toHaveAttribute("data-span-id", "root");

    // 3 个 chat 是 depth 1，3 个 tool 是 depth 2（三层，与 demo.py 终端树同构）
    const chats = screen.getAllByRole("button", { name: /^span chat gpt-4o-mini/ });
    expect(chats).toHaveLength(3);
    for (const chat of chats) expect(chat).toHaveAttribute("data-depth", "1");

    const tools = ["tool1", "tool2", "tool3"].map((id) =>
      document.querySelector(`button[data-span-id="${id}"]`) as HTMLElement
    );
    for (const tool of tools) expect(tool).toHaveAttribute("data-depth", "2");

    // 树头：全值 trace_id（M3，title 可 hover）+ span 计数
    expect(screen.getByTitle("4bf92f3577b34da6a3ce929d0e0e4736")).toHaveTextContent(
      "4bf92f3577b34da6a3ce929d0e0e4736"
    );
    expect(screen.getByText(/共 7 个 span/)).toBeInTheDocument();
  });

  it("block 节点：ERROR 红状态 + 红「拦截」徽标 + 理由文案（block_reason）", async () => {
    stubDetail(DEMO_SPANS_JSON);
    renderPanel();
    const blocked = await screen.findByRole("button", {
      name: /^span execute_tool verify_customer_id（ERROR）/,
    });
    expect(blocked.className).toContain("err");
    expect(within(blocked).getByText("ERROR")).toBeInTheDocument();
    expect(within(blocked).getByText("拦截")).toBeInTheDocument();

    // 点开节点 → 详情卡出拦截理由
    fireEvent.click(blocked);
    expect(await screen.findByText("拦截理由")).toBeInTheDocument();
    expect(
      screen.getAllByText(/命中规则 r1-pii-id-card（客户身份证号外泄）：110101199003071234/).length
    ).toBeGreaterThan(0);
  });

  it("观察期节点：UNSET 状态 + 琥珀「观察期」徽标（verdict=allow + matched_rule）", async () => {
    stubDetail(DEMO_SPANS_JSON);
    renderPanel();
    const observed = await screen.findByRole("button", {
      name: /^span execute_tool query_contact_by_phone/,
    });
    expect(observed.className).not.toContain("err");
    const badge = within(observed).getByText("观察期");
    expect(badge).toHaveAttribute("data-tone", "observe");
  });

  it("未命中规则的 execute_tool → 灰「放行」（带推断说明）；root/chat 无 verdict 徽标", async () => {
    stubDetail(DEMO_SPANS_JSON);
    renderPanel();
    const allowed = await screen.findByRole("button", { name: /^span execute_tool query_user_db/ });
    const badge = within(allowed).getByText("放行");
    // 灰放行不是 attributes 直读（契约 §3.4：未命中规则不写 verdict）——title 必须点明推断
    expect(badge).toHaveClass("b-allow");
    expect(badge.getAttribute("title")).toContain("推断");

    const root = screen.getByRole("button", { name: /^span invoke_agent/ });
    expect(within(root).queryByText("放行")).toBeNull();
    expect(within(root).queryByText("观察期")).toBeNull();
    expect(within(root).queryByText("拦截")).toBeNull();
  });

  it("时长 = end-start 一位小数；进行中 span 显示「进行中」（end 为 null）", async () => {
    stubDetail(DEMO_SPANS_JSON.replace(
      '"end_time_unix_nano":1794473008364093900',
      '"end_time_unix_nano":null'
    ));
    renderPanel();
    const root = await screen.findByRole("button", { name: /^span invoke_agent/ });
    // 1794473008370309100 - 1794473008218267400 = 152041700 ns = 152.0 ms
    expect(within(root).getByText("152.0 ms")).toBeInTheDocument();

    const running = screen.getByRole("button", { name: /verify_customer_id（进行中）/ });
    expect(within(running).getByText("进行中")).toBeInTheDocument();
    expect(running.className).toContain("running");
  });

  it("孤儿 span（父不在平铺集）挂根并列 + 顶部告警，不静默丢弃", async () => {
    const orphan = `
{"trace_id":"tid","span_id":"root","parent_span_id":null,"name":"invoke_agent customer-service",
 "kind":"INTERNAL","start_time_unix_nano":1794473008218267400,"end_time_unix_nano":1794473008370309100,
 "status_code":"UNSET","status_message":null,"attributes":{},"events":[],"agent_id":null},
{"trace_id":"tid","span_id":"lost","parent_span_id":"ghost","name":"execute_tool lost_span",
 "kind":"INTERNAL","start_time_unix_nano":1794473008313710100,"end_time_unix_nano":1794473008320084800,
 "status_code":"UNSET","status_message":null,"attributes":{},"events":[],"agent_id":null}`;
    stubDetail(orphan);
    renderPanel();

    expect(await screen.findByRole("alert")).toHaveTextContent(/找不到父节点/);
    const lost = screen.getByRole("button", { name: /^span execute_tool lost_span/ });
    expect(lost).toHaveAttribute("data-depth", "0");
    expect(within(lost).getByText("孤儿")).toBeInTheDocument();
  });

  it("环成员（A↔B）告警文案说「成环」而非「父不在本 trace 内」（评审第一拍 P3）", async () => {
    // 两个 span 的父明明都在平铺集里，只是互相指向——用「找不到父节点」解释是错的
    const cyclic = `
{"trace_id":"tid","span_id":"a","parent_span_id":"b","name":"execute_tool span_a",
 "kind":"INTERNAL","start_time_unix_nano":1794473008218267400,"end_time_unix_nano":1794473008370309100,
 "status_code":"UNSET","status_message":null,"attributes":{},"events":[],"agent_id":null},
{"trace_id":"tid","span_id":"b","parent_span_id":"a","name":"execute_tool span_b",
 "kind":"INTERNAL","start_time_unix_nano":1794473008313710100,"end_time_unix_nano":1794473008320084800,
 "status_code":"UNSET","status_message":null,"attributes":{},"events":[],"agent_id":null}`;
    stubDetail(cyclic);
    renderPanel();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/成环/);
    expect(alert).not.toHaveTextContent(/找不到父节点/);
    // 两个节点都还在（没丢），都在根层
    expect(screen.getByRole("button", { name: /^span execute_tool span_a/ })).toHaveAttribute(
      "data-depth",
      "0"
    );
    expect(screen.getByRole("button", { name: /^span execute_tool span_b/ })).toHaveAttribute(
      "data-depth",
      "0"
    );
  });

  it("切换 trace_id → 重新取详情、树随之切换、span 选中被清空", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const isSecond = url.includes("second");
      // 注意：空 spans 用空字符串拼接，不能给 "[]"（会变成 [[]]，渲染出非法 span）
      const spans = isSecond ? "" : DEMO_SPANS_JSON;
      const body = `{"trace_id":"x","spans":[${spans}]}`;
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(body) });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<TraceDetailPanel traceId="first" />);

    const tool = await screen.findByRole("button", { name: /^span execute_tool query_user_db/ });
    fireEvent.click(tool);
    expect(await screen.findByText("ATTRIBUTES · 2")).toBeInTheDocument();
    rerender(<TraceDetailPanel traceId="second" />);

    await waitFor(() => expect(screen.getByText("本 trace 暂无 span")).toBeInTheDocument());
    expect(screen.queryByText(/ATTRIBUTES/)).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/api/traces/second", expect.anything());
  });
});

describe("span 详情卡（M2-05 #20）", () => {
  it("attributes 键值表原样展示：含点键逐字可见（不解析嵌套）", async () => {
    stubDetail(DEMO_SPANS_JSON);
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /^span execute_tool verify_customer_id/ }));

    const card = await screen.findByText("ATTRIBUTES · 5");
    expect(card).toBeInTheDocument();
    // 含点键完整字符串原样作为键名出现
    expect(screen.getByText("skill_observability.block_reason")).toBeInTheDocument();
    expect(screen.getByText("skill_observability.matched_rule")).toBeInTheDocument();
    expect(screen.getByText("skill_observability.verdict")).toBeInTheDocument();
    expect(screen.getByText("gen_ai.operation.name")).toBeInTheDocument();
  });

  it("长键（35 字符）不把值挤成竖条：键与值分处两个行内元素、值完整成串", async () => {
    // 2026-11-12 浏览器 QA 实录：`skill_observability.matched_rule` + 值同行时，
    // 值被压到十几像素宽，r1b-pii-phone-audit 竖排成 4 行。CSS 已改 flex-wrap；
    // jsdom 不做布局，这里守 DOM 结构：键/值是两个并列 span（值可整串读取）。
    stubDetail(DEMO_SPANS_JSON);
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /^span execute_tool query_contact_by_phone/ }));

    const row = (await screen.findByText("skill_observability.matched_rule")).closest(".attr");
    expect(row).not.toBeNull();
    const value = row?.querySelector(".v");
    expect(value?.textContent).toBe("r1b-pii-phone-audit");
    // 键与值不互相嵌套（嵌套会让长键把值挤到剩余宽度）
    expect(row?.querySelector(".k")?.contains(value ?? null)).toBe(false);
  });

  it("M5：events 空数组 → 不渲染 events 卡（连标题都不出现）", async () => {
    stubDetail(DEMO_SPANS_JSON);
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /^span execute_tool query_user_db/ }));

    await screen.findByText(/ATTRIBUTES/);
    expect(screen.queryByText(/EVENTS/)).toBeNull();
    // 不渲染空状态替代物
    expect(screen.queryByText("无 events")).toBeNull();
  });

  it("events 非空 → 事件卡显示 name 与事件 attributes", async () => {
    const withEvent = DEMO_SPANS_JSON.replace(
      `"attributes":{"gen_ai.operation.name":"execute_tool","gen_ai.tool.name":"query_user_db"},
 "events":[]`,
      `"attributes":{"gen_ai.operation.name":"execute_tool","gen_ai.tool.name":"query_user_db"},
 "events":[{"name":"exception","timestamp":1794473008320000000,
   "attributes":{"exception.type":"ValueError","exception.message":"boom"}}]`
    );
    stubDetail(withEvent);
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /^span execute_tool query_user_db/ }));

    expect(await screen.findByText(/EVENTS · 1/)).toBeInTheDocument();
    expect(screen.getByText("exception")).toBeInTheDocument();
    expect(screen.getByText("ValueError")).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it("「查看审计行」是禁用态占位（M8 反链在 M2-08 接通）", async () => {
    stubDetail(DEMO_SPANS_JSON);
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /^span invoke_agent/ }));
    const link = await screen.findByRole("button", { name: "查看审计行" });
    expect(link).toBeDisabled();
    expect(link).toHaveAttribute("title", expect.stringContaining("M2-08"));
  });
});

describe("trace_id 复制（M3）", () => {
  it("hover 全值在 title 上；点复制 → 写入剪贴板并回显「已复制」", async () => {
    stubDetail(DEMO_SPANS_JSON);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    renderPanel("abc123def456");
    const tid = await screen.findByTitle("abc123def456");
    expect(tid).toHaveTextContent("abc123def456");

    fireEvent.click(screen.getByRole("button", { name: "复制 trace_id" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("abc123def456"));
    expect(await screen.findByText("已复制")).toBeInTheDocument();
  });

  it("剪贴板不可用 → 回显「复制失败」，不假装成功", async () => {
    stubDetail(DEMO_SPANS_JSON);
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    // execCommand 回退也失败
    (document as unknown as { execCommand: () => boolean }).execCommand = () => false;

    renderPanel("abc123def456");
    await screen.findByTitle("abc123def456");
    fireEvent.click(screen.getByRole("button", { name: "复制 trace_id" }));

    expect(await screen.findByText("复制失败")).toBeInTheDocument();
  });
});

describe("详情取数失败（M2-05 #20）", () => {
  it("404 → 「trace 不存在」+ 重试按钮", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve('{"detail":"trace not found"}'),
      })
    );
    renderPanel("gone");
    expect(await screen.findByRole("alert")).toHaveTextContent("trace 不存在");
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });

  it("500 → 错误文案带 HTTP 状态与 detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('{"detail":"boom"}'),
      })
    );
    renderPanel("x");
    expect(await screen.findByRole("alert")).toHaveTextContent("取数失败（HTTP 500）：boom");
  });

  it("组件级切换 trace：A 的在飞请求被取消（评审第二拍 N1 回归）", async () => {
    // Store 单测已覆盖 A→B→C；这条走真实组件，确认到组件层行为不变。
    const signals: Array<{ url: string; signal: AbortSignal }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init?: { signal?: AbortSignal }) => {
        if (init?.signal) signals.push({ url, signal: init.signal });
        return new Promise(() => {}); // 挂起：模拟慢详情接口
      })
    );

    const { rerender } = render(<TraceDetailPanel traceId="trace-A" />);
    await waitFor(() => expect(signals.length).toBeGreaterThanOrEqual(1));
    const aCall = signals.find((s) => s.url === "/api/traces/trace-A");
    expect(aCall).toBeDefined();
    expect(aCall?.signal.aborted).toBe(false);

    rerender(<TraceDetailPanel traceId="trace-B" />);
    await waitFor(() => expect(aCall?.signal.aborted).toBe(true));

    const bCall = signals.find((s) => s.url === "/api/traces/trace-B");
    expect(bCall).toBeDefined();
    expect(bCall?.signal.aborted).toBe(false);
  });

  it("纯卸载（不切 trace）也取消在飞请求 —— effect cleanup 的唯一职责", async () => {
    // 上面的切换用例即使 hook 不写 cleanup 也会过（新请求的 abortActiveRequest 兜住了），
    // 所以 cleanup 的真正价值只在「卸载且没有后继请求」：离开 Trace 页、选中被清空。
    // 这条用例专门守它，mutation（把 cleanup 改成空函数）会红。
    const signals: Array<{ url: string; signal: AbortSignal }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init?: { signal?: AbortSignal }) => {
        if (init?.signal) signals.push({ url, signal: init.signal });
        return new Promise(() => {});
      })
    );

    const { unmount } = render(<TraceDetailPanel traceId="trace-solo" />);
    await waitFor(() => expect(signals.length).toBeGreaterThanOrEqual(1));
    const call = signals.find((s) => s.url === "/api/traces/trace-solo");
    expect(call?.signal.aborted).toBe(false);

    unmount();
    await waitFor(() => expect(call?.signal.aborted).toBe(true));
  });

});
