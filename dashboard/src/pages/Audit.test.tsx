/**
 * 审计页冒烟（M2-07 #22）：真实线路形状 → 行要素 / 三徽标 / 四段筛选 / 分页 / 页码重置。
 *
 * fetch 走 mock（不起后端）。纳秒按后端真实序列化以**数字字面量**下发，
 * 由 losslessJson 在文本层转字符串——fixture 必须拼原始 JSON 文本。
 *
 * 重点验收（票面）：
 * - 四段切换 = 换查询参数，**前端不得自算过滤**（断言 URL，而不是断言过滤后的行）；
 * - 筛选切换后页码重置到 1；
 * - 三徽标在 M1 场景数据形状上各自出现，文案「观察期命中」而非「警告」。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HashRouter } from "react-router-dom";

import AuditPage from "./Audit";

interface RowSpec {
  id: number;
  tool?: string;
  agent?: string;
  verdict?: "allow" | "block";
  ruleId?: string | null;
  ruleName?: string | null;
  action?: "block" | "audit" | null;
  reason?: string | null;
  truncated?: boolean;
  nano?: string;
}

/** 一行审计的原始 JSON 片段（键序与后端 audit 序列化一致；纳秒是数字字面量）。 */
function wireRow(spec: RowSpec): string {
  const {
    id,
    tool = "query_user_db",
    agent = "customer-service",
    verdict = "allow",
    ruleId = null,
    ruleName = null,
    action = null,
    reason = null,
    truncated = false,
    nano = "1794389455893772000",
  } = spec;
  const json = (v: string | null) => (v === null ? "null" : JSON.stringify(v));
  return (
    `{"id":${id},"trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","span_id":"00f067aa0ba902b7",` +
    `"agent_id":${json(agent)},"tool_name":${json(tool)},"verdict":"${verdict}",` +
    `"rule_id":${json(ruleId)},"rule_name":${json(ruleName)},"action":${json(action)},` +
    `"reason":${json(reason)},"payload":{"k":"v"},"payload_truncated":${truncated},` +
    `"created_at_unix_nano":${nano}}`
  );
}

/**
 * 按「筛选键」返回分页体。key = 查询串（如 `verdict=allow` / `action=audit` / `all`）。
 * 用真实的契约参数做键，任何自算过滤（不发参数）的实现在这里会直接拿不到数据。
 */
function stubAuditApi(
  byFilter: Record<string, { rows: string[]; total?: number }>,
  pageSize = 20
) {
  const calls: string[] = [];
  const fn = vi.fn().mockImplementation((url: string) => {
    calls.push(url);
    const m = /^\/api\/audits\?page=(\d+)&page_size=(\d+)(?:&(.+))?$/.exec(url);
    if (!m) return Promise.reject(new Error(`unexpected url: ${url}`));
    const page = Number(m[1]);
    const key = m[3] ?? "all";
    const entry = byFilter[key] ?? { rows: [], total: 0 };
    const total = entry.total ?? entry.rows.length;
    const items = entry.rows.join(",");
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          `{"items":[${items}],"page":${page},"page_size":${pageSize},"total":${total}}`
        ),
    });
  });
  vi.stubGlobal("fetch", fn);
  return { calls, fn };
}

function renderPage() {
  return render(
    <HashRouter>
      <AuditPage />
    </HashRouter>
  );
}

/** M1 场景三行形状：未命中放行 / 观察期命中 / 拦截。 */
const M1_ROWS = {
  all: {
    rows: [
      wireRow({ id: 3, tool: "verify_customer_id", verdict: "block", ruleId: "r1-pii-id-card", ruleName: "客户身份证号外泄", action: "block", reason: "命中规则 r1-pii-id-card（客户身份证号外泄）：110101199003071234" }),
      wireRow({ id: 2, tool: "query_contact_by_phone", ruleId: "r1b-pii-phone-audit", ruleName: "客户手机号外泄（观察期）", action: "audit", reason: "命中规则 r1b-pii-phone-audit（客户手机号外泄（观察期））：13812345678" }),
      wireRow({ id: 1, tool: "query_user_db", reason: null }),
    ],
    total: 3,
  },
  "verdict=block": { rows: [wireRow({ id: 3, tool: "verify_customer_id", verdict: "block", ruleId: "r1-pii-id-card", action: "block", reason: "命中规则 r1-pii-id-card" })] },
  "verdict=allow": {
    rows: [
      wireRow({ id: 2, tool: "query_contact_by_phone", ruleId: "r1b-pii-phone-audit", action: "audit", reason: "命中规则 r1b-pii-phone-audit" }),
      wireRow({ id: 1, tool: "query_user_db" }),
    ],
  },
  "action=audit": {
    rows: [wireRow({ id: 2, tool: "query_contact_by_phone", ruleId: "r1b-pii-phone-audit", action: "audit", reason: "命中规则 r1b-pii-phone-audit" })],
  },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("审计表格渲染（M2-07 #22）", () => {
  it("行要素齐全：时间 / agent_id / 工具 / verdict 徽标 / 命中规则 / 理由", async () => {
    stubAuditApi(M1_ROWS);
    renderPage();

    const row = await screen.findByRole("button", { name: /verify_customer_id/ });
    expect(within(row).getByText("customer-service")).toBeInTheDocument(); // #2 M4
    expect(within(row).getByText("r1-pii-id-card")).toBeInTheDocument();
    expect(within(row).getByText(/110101199003071234/)).toBeInTheDocument();
    expect(within(row).getByText(/\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}/)).toBeInTheDocument();
  });

  it("三徽标各自出现：红拦截 / 琥珀观察期命中 / 灰放行", async () => {
    stubAuditApi(M1_ROWS);
    renderPage();

    const blockRow = await screen.findByRole("button", { name: /verify_customer_id/ });
    expect(within(blockRow).getByText("拦截")).toBeInTheDocument();
    expect(within(blockRow).queryByText("观察期命中")).toBeNull();

    const observeRow = screen.getByRole("button", { name: /query_contact_by_phone/ });
    // 观察期命中行同时是「放行」（verdict=allow）——两种事实并列，与原型一致
    expect(within(observeRow).getByText("放行")).toBeInTheDocument();
    expect(within(observeRow).getByText("观察期命中")).toBeInTheDocument();

    const allowRow = screen.getByRole("button", { name: /query_user_db/ });
    expect(within(allowRow).getByText("放行")).toBeInTheDocument();
    expect(within(allowRow).queryByText("观察期命中")).toBeNull();
    expect(within(allowRow).getByText("未命中任何规则")).toBeInTheDocument();

    // 文案逐徽标核对：绝不出现「警告」（S2）
    expect(screen.queryByText(/警告/)).toBeNull();

    // 色档逐徽标钉住（评审 P3-3 / MUT-E：琥珀改灰曾全绿——分档对、色名错抓不到）
    // data-tone 由 TraceRow 的 Badge 统一落下，三信号色语义见 CONTEXT.md 看板术语
    expect(within(blockRow).getByText("拦截")).toHaveAttribute("data-tone", "block");
    expect(within(observeRow).getByText("观察期命中")).toHaveAttribute("data-tone", "observe");
    expect(within(observeRow).getByText("放行")).toHaveAttribute("data-tone", "allow");
    expect(within(allowRow).getByText("放行")).toHaveAttribute("data-tone", "allow");
  });

  it("payload_truncated=1 → 显示截断标记；=0 → 不显示", async () => {
    stubAuditApi({
      all: {
        rows: [
          wireRow({ id: 2, tool: "big_payload_tool", truncated: true, nano: "1794389455893772001" }),
          wireRow({ id: 1, tool: "small_payload_tool", truncated: false }),
        ],
      },
    });
    renderPage();

    const truncatedRow = await screen.findByRole("button", { name: /big_payload_tool/ });
    expect(within(truncatedRow).getByText("截断")).toBeInTheDocument();
    const normalRow = screen.getByRole("button", { name: /small_payload_tool/ });
    expect(within(normalRow).queryByText("截断")).toBeNull();
  });

  it("空结果 → 空态文案，不渲染分页", async () => {
    stubAuditApi({ all: { rows: [], total: 0 } });
    renderPage();
    await screen.findByText("无匹配审计记录");
    expect(screen.queryByRole("navigation", { name: /审计列表分页/ })).toBeNull();
  });

  it("取数失败 → 错误文案 + 重试（不白屏）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          text: () => Promise.resolve(JSON.stringify({ detail: "boom" })),
        })
      )
    );
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent(/HTTP 500/);
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });
});

describe("四段筛选（服务端口径，前端不自算）", () => {
  it("四段齐全且默认「全部」", async () => {
    stubAuditApi(M1_ROWS);
    renderPage();
    await screen.findByRole("button", { name: /verify_customer_id/ });

    const group = screen.getByRole("group", { name: "审计筛选" });
    for (const label of ["全部", "拦截", "放行", "观察期"]) {
      expect(within(group).getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(within(group).getByRole("button", { name: "全部" })).toHaveAttribute("aria-pressed", "true");
  });

  it("点各段 → 请求带上对应契约参数（观察期走 action=audit，不是前端过滤）", async () => {
    const { calls } = stubAuditApi(M1_ROWS);
    renderPage();
    await screen.findByRole("button", { name: /verify_customer_id/ });

    const group = screen.getByRole("group", { name: "审计筛选" });
    fireEvent.click(within(group).getByRole("button", { name: "拦截" }));
    await waitFor(() => expect(calls.some((u) => u.includes("&verdict=block"))).toBe(true));

    fireEvent.click(within(group).getByRole("button", { name: "放行" }));
    await waitFor(() => expect(calls.some((u) => u.includes("&verdict=allow"))).toBe(true));

    fireEvent.click(within(group).getByRole("button", { name: "观察期" }));
    await waitFor(() => expect(calls.some((u) => u.includes("&action=audit"))).toBe(true));
    // 观察期只发 action：多补一个 verdict=allow 会让口径出现第二处来源
    expect(calls.filter((u) => u.includes("&action=audit")).every((u) => !u.includes("verdict="))).toBe(true);

    fireEvent.click(within(group).getByRole("button", { name: "全部" }));
    await waitFor(() => {
      const last = calls[calls.length - 1];
      expect(last).not.toContain("verdict=");
      expect(last).not.toContain("action=");
    });
  });

  it("切到观察期 → 只渲染该段结果（数据来自服务端，前端不筛）", async () => {
    stubAuditApi(M1_ROWS);
    renderPage();
    await screen.findByRole("button", { name: /verify_customer_id/ });

    fireEvent.click(screen.getByRole("button", { name: "观察期" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /verify_customer_id/ })).toBeNull());
    expect(screen.getByRole("button", { name: /query_contact_by_phone/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /query_contact_by_phone/ })).toHaveTextContent("观察期命中");
  });

  it("点当前段不重复请求", async () => {
    const { calls } = stubAuditApi(M1_ROWS);
    renderPage();
    await screen.findByRole("button", { name: /verify_customer_id/ });
    const before = calls.length;
    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(before);
  });
});

describe("分页与筛选联动（满页 QA 的自动化面）", () => {
  /** 造 25 行：按 id 降序（与契约 ORDER BY 一致）。 */
  function manyRows(count: number): string[] {
    return Array.from({ length: count }, (_, i) =>
      wireRow({ id: count - i, tool: `tool_${count - i}`, nano: String(1794389455893772000 + i) })
    );
  }

  it("满页 20 行 + 21 条 → 第 2 页可翻并渲染剩余行", async () => {
    const rows = manyRows(21);
    // 分页感知的 stub：page=1 给前 20 条、page=2 给第 21 条
    const fn = vi.fn().mockImplementation((url: string) => {
      const m = /^\/api\/audits\?page=(\d+)&page_size=(\d+)(?:&(.+))?$/.exec(url);
      if (!m) return Promise.reject(new Error(`unexpected url: ${url}`));
      const page = Number(m[1]);
      const items = (page === 1 ? rows.slice(0, 20) : rows.slice(20)).join(",");
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(`{"items":[${items}],"page":${page},"page_size":20,"total":21}`),
      });
    });
    vi.stubGlobal("fetch", fn);

    renderPage();
    await screen.findByRole("button", { name: /tool_21/ });
    expect(screen.getByRole("navigation", { name: /审计列表分页/ })).toHaveTextContent("共 21 条 · 第 1/2 页");

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await screen.findByRole("button", { name: /tool_1/ });
    expect(screen.getByRole("navigation", { name: /审计列表分页/ })).toHaveTextContent("第 2/2 页");
    expect(screen.queryByRole("button", { name: /tool_21/ })).toBeNull();
  });

  it("在第 2 页切换筛选 → 请求回到 page=1 且页码显示 1", async () => {
    const rows = manyRows(25);
    const calls: string[] = [];
    const fn = vi.fn().mockImplementation((url: string) => {
      calls.push(url);
      const m = /^\/api\/audits\?page=(\d+)&page_size=(\d+)(?:&(.+))?$/.exec(url);
      if (!m) return Promise.reject(new Error(`unexpected url: ${url}`));
      const page = Number(m[1]);
      const key = m[3] ?? "all";
      // 观察期筛选：服务端只回 1 行、共 1 页（真实场景里第 2 页会是空的）
      const source = key === "action=audit" ? [wireRow({ id: 2, tool: "phone_only", action: "audit" })] : rows;
      const total = source.length;
      const slice = source.slice((page - 1) * 20, page * 20);
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(`{"items":[${slice.join(",")}],"page":${page},"page_size":20,"total":${total}}`),
      });
    });
    vi.stubGlobal("fetch", fn);

    renderPage();
    await screen.findByRole("button", { name: /tool_25/ });
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await screen.findByRole("button", { name: /tool_5/ });
    expect(screen.getByRole("navigation", { name: /审计列表分页/ })).toHaveTextContent("第 2/2 页");

    fireEvent.click(screen.getByRole("button", { name: "观察期" }));
    await screen.findByRole("button", { name: /phone_only/ });

    // 票面验收：筛选切换后页码重置到 1（请求与显示都要回到 1）
    const last = calls[calls.length - 1];
    expect(last).toContain("page=1");
    expect(last).toContain("action=audit");
    expect(screen.getByRole("navigation", { name: /审计列表分页/ })).toHaveTextContent("第 1/1 页");
    expect(screen.queryByRole("button", { name: /tool_25/ })).toBeNull();
  });

  it("总数缩水后请求页越界 → 回落到最后一页，不渲染「第 2/1 页」（评审 P2-1）", async () => {
    // 场景复刻评审探针：第 1 页 25 条 → 翻第 2 页时 DB 已被重置（demo.py 启动
    // 即 unlink）→ 服务端只剩 3 条。响应照契约原样回显 page=2、total=3。
    const rows = manyRows(25);
    let dbReset = false; // 翻页前翻真，模拟「停在页面上的同时库被换掉」
    const calls: string[] = [];
    const fn = vi.fn().mockImplementation((url: string) => {
      calls.push(url);
      const m = /^\/api\/audits\?page=(\d+)&page_size=(\d+)(?:&(.+))?$/.exec(url);
      if (!m) return Promise.reject(new Error(`unexpected url: ${url}`));
      const page = Number(m[1]);
      if (dbReset) {
        // 重置后的库只有 3 行；服务端不拦截越界页，原样回 page=2 + total=3
        const shrunk = [3, 2, 1].map((id) => wireRow({ id, tool: `tool_${id}` }));
        const slice = shrunk.slice((page - 1) * 20, page * 20);
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(`{"items":[${slice.join(",")}],"page":${page},"page_size":20,"total":3}`),
        });
      }
      const slice = rows.slice((page - 1) * 20, page * 20);
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(`{"items":[${slice.join(",")}],"page":${page},"page_size":20,"total":25}`),
      });
    });
    vi.stubGlobal("fetch", fn);

    renderPage();
    await screen.findByRole("button", { name: /tool_25/ });
    dbReset = true; // 此刻 demo 重启、库清空重跑，只剩 3 行审计
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));

    // 缩水到 3 条后请求页 2 已越界：必须回落到最后一页（第 1 页）重新取数，
    // 而不是照搬响应里的 page=2 渲染出「共 3 条 · 第 2/1 页」
    await screen.findByRole("button", { name: /tool_3/ });
    expect(screen.getByRole("navigation", { name: /审计列表分页/ })).toHaveTextContent("共 3 条 · 第 1/1 页");
    expect(screen.queryByRole("button", { name: /tool_25/ })).toBeNull();
    // 回落是重新发起了 page=1 请求（不是拿越界响应直接渲染）
    expect(calls[calls.length - 1]).toContain("page=1");
  });
});
