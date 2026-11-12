/**
 * Trace 列表页冒烟（M2-04 #19）：真实数据形状 → 行渲染 / 徽标 / 分页 / 选中态 / 空态。
 *
 * fetch 走 mock（不起后端）。线路形状按后端真实序列化：19 位纳秒是 JSON **数字字面量**，
 * 由 losslessJson 在文本层改写成字符串——所以 fixture 以原始 JSON 文本拼接（若先用 JS
 * number 字面量，进入 JSON.stringify 前已被 Number 舍入，就不是真实线路形状了）。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HashRouter } from "react-router-dom";

import TracePage, { isPageChangeAllowed } from "./Trace";
import { pageWindow, totalPagesOf } from "../components/TracePager";

/** 一条列表项的原始 JSON 片段：纳秒以数字字面量下发（模拟 FastAPI 序列化）。 */
function wireItemJson(fields: {
  trace_id?: string;
  name?: string;
  agent_id?: string;
  start?: string;
  end?: string | null;
  span_count?: number;
  blocked?: boolean;
}): string {
  const {
    trace_id = "4bf92f3577b34da6a3ce929d0e0e4736",
    name = "invoke_agent customer-service",
    agent_id = "customer-service",
    start = "1794389455893772000",
    end = "1794389456024277000",
    span_count = 7,
    blocked = true,
  } = fields;
  const endJson = end === null ? "null" : end;
  return (
    `{"trace_id":"${trace_id}","name":"${name}","agent_id":${agent_id === null ? "null" : `"${agent_id}"`},` +
    `"start_time_unix_nano":${start},"end_time_unix_nano":${endJson},` +
    `"status_code":"UNSET","span_count":${span_count},"blocked":${blocked}}`
  );
}

/** 按 URL 返回分页体；pages[page] 为 items 原始 JSON 片段数组。
 *  details: trace_id → 详情响应原始 JSON（M2-05 起点行会触发 GET /api/traces/{id}）。 */
function stubPagedApi(
  pages: Record<number, string[]>,
  total: number,
  pageSize = 20,
  details: Record<string, string> = {}
) {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    const detail = /^\/api\/traces\/([^?]+)$/.exec(url);
    if (detail) {
      const traceId = decodeURIComponent(detail[1]);
      const body = details[traceId] ?? `{"trace_id":"${traceId}","spans":[]}`;
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(body) });
    }
    const m = /^\/api\/traces\?page=(\d+)&page_size=(\d+)$/.exec(url);
    if (!m) return Promise.reject(new Error(`unexpected url: ${url}`));
    const page = Number(m[1]);
    const items = (pages[page] ?? []).join(",");
    const body = `{"items":[${items}],"page":${page},"page_size":${pageSize},"total":${total}}`;
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(body) });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderPage() {
  return render(
    <HashRouter>
      <TracePage />
    </HashRouter>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Trace 列表渲染（M2-04 #19）", () => {
  it("真实数据形状 → 行要素齐全（名称/agent_id/时间/HH:MM:SS.mmm/span 数/拦截徽标）", async () => {
    stubPagedApi({ 1: [wireItemJson({})] }, 1);
    renderPage();

    const row = await screen.findByRole("button", { name: /invoke_agent customer-service/ });
    expect(within(row).getByText("customer-service")).toBeInTheDocument();
    expect(within(row).getByText("拦截")).toBeInTheDocument();
    expect(within(row).getByText("7 个 span")).toBeInTheDocument();
    // HH:MM:SS.mmm 形状（时区无关断言）
    expect(within(row).getByText(/\d{2}:\d{2}:\d{2}\.\d{3}/)).toBeInTheDocument();
    // 票面验收④：纳秒在组件树里必须是字符串，前端格式化的末三位来自真实毫秒
    const d = new Date(Number(1794389455893772000n / 1_000_000n));
    const expected =
      `${String(d.getHours()).padStart(2, "0")}:` +
      `${String(d.getMinutes()).padStart(2, "0")}:` +
      `${String(d.getSeconds()).padStart(2, "0")}.` +
      `${String(d.getMilliseconds()).padStart(3, "0")}`;
    // 行内文本是「MM-DD HH:MM:SS.mmm」，用包含匹配断言精确毫秒值
    expect(within(row).getByText(new RegExp(expected.replace(".", "\\.")))).toBeInTheDocument();
  });

  it("blocked=false 的行不出现拦截徽标", async () => {
    stubPagedApi({ 1: [wireItemJson({ trace_id: "t2", blocked: false })] }, 1);
    renderPage();
    const row = await screen.findByRole("button", { name: /invoke_agent/ });
    expect(within(row).queryByText("拦截")).toBeNull();
  });

  it("end_time_unix_nano 为 null → 进行中徽标；有值 → 无（契约语义，非计时器）", async () => {
    stubPagedApi(
      {
        1: [
          wireItemJson({ trace_id: "run", name: "invoke_agent running", end: null }),
          wireItemJson({ trace_id: "done", name: "invoke_agent done", blocked: false }),
        ],
      },
      2
    );
    renderPage();

    const running = await screen.findByRole("button", { name: /invoke_agent running/ });
    expect(within(running).getByText("进行中")).toBeInTheDocument();
    expect(within(running).getByText("进行中")).toHaveAttribute("data-tone", "run");

    const done = screen.getByRole("button", { name: /invoke_agent done/ });
    expect(within(done).queryByText("进行中")).toBeNull();
  });

  it("空列表 → 空态文案（非白屏），且不渲染分页控件", async () => {
    stubPagedApi({ 1: [] }, 0);
    renderPage();
    expect(await screen.findByText("暂无 trace")).toBeInTheDocument();
    expect(screen.getByText("跑 python demo.py 产生数据")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Trace 列表分页" })).toBeNull();
  });

  it("点行进入选中态（aria-pressed 翻转），右栏加载详情并回显 trace_id", async () => {
    stubPagedApi({ 1: [wireItemJson({})] }, 1);
    renderPage();
    const row = await screen.findByRole("button", { name: /invoke_agent customer-service/ });
    expect(row).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(row);

    expect(row).toHaveAttribute("aria-pressed", "true");
    expect(row.className).toContain("selected");
    // 右栏 trace 头带全值 trace_id（M3：不截断）
    expect(await screen.findByTitle("4bf92f3577b34da6a3ce929d0e0e4736")).toBeInTheDocument();
    expect(screen.getByText("本 trace 暂无 span")).toBeInTheDocument();
  });

  it("满页 20 行时每行的 meta 要素全在场（限高容器压扁行的防线）", async () => {
    // 2026-11-12 QA 实录：.tlist 限高 flex 列容器把 20 行压到 ~25px/行，
    // overflow:hidden 裁掉整段 meta（agent_id/时间/徽标/span 数消失）。
    // jsdom 不做布局计算，无法验「高 25px」——改为对满页行逐个断言 meta 四要素在场，
    // 配合浏览器 QA 的行高目视（见 #19 决议评论）。
    const page = Array.from({ length: 20 }, (_, i) =>
      wireItemJson({ trace_id: `t${i}`, name: `row ${i}`, blocked: i % 2 === 0 })
    );
    stubPagedApi({ 1: page }, 20);
    renderPage();

    const rows = await screen.findAllByRole("button", { name: /^row \d+/ });
    expect(rows).toHaveLength(20);
    for (const row of rows) {
      expect(within(row).getByText("customer-service")).toBeInTheDocument();
      expect(within(row).getByText(/^\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/)).toBeInTheDocument();
      expect(within(row).getByText("7 个 span")).toBeInTheDocument();
    }
    // 奇偶 blocked 交替：10 行带拦截徽标（徽标不算在白造数据里）
    const badges = rows.filter((r) => within(r).queryByText("拦截") !== null);
    expect(badges).toHaveLength(10);
  });

  it("只有一页时仍显示分页控件（「共 1 条」可见——默认 demo 单条场景）", async () => {
    stubPagedApi({ 1: [wireItemJson({})] }, 1);
    renderPage();
    await screen.findByRole("button", { name: /invoke_agent/ });
    const pager = screen.getByRole("navigation", { name: "Trace 列表分页" });
    expect(pager).toHaveTextContent("共 1 条 · 第 1/1 页");
    expect(screen.getByRole("button", { name: "上一页" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下一页" })).toBeDisabled();
  });
});

describe("Trace 分页（M2-04 #19）", () => {
  it("第二页可翻：请求 page=2 并渲染该页数据，翻页清空选中", async () => {
    const fetchMock = stubPagedApi(
      {
        1: [wireItemJson({ trace_id: "p1", name: "trace page1" })],
        2: [wireItemJson({ trace_id: "p2", name: "trace page2", blocked: false })],
      },
      21
    );
    renderPage();

    const first = await screen.findByRole("button", { name: /trace page1/ });
    fireEvent.click(first);
    expect(first).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));

    await screen.findByRole("button", { name: /trace page2/ });
    expect(fetchMock).toHaveBeenCalledWith("/api/traces?page=2&page_size=20", expect.anything());
    // 翻页后选中清空（跨页残留选中会让右栏与列表不同页）
    expect(screen.queryByText("SPAN 树")).toBeNull();
    expect(screen.getByText(/从左侧选择一条 trace/)).toBeInTheDocument();
  });

  it("第一页「上一页」disabled；末页「下一页」disabled", async () => {
    stubPagedApi(
      { 1: [wireItemJson({})], 2: [wireItemJson({ trace_id: "x" })] },
      21
    );
    renderPage();
    await screen.findByRole("button", { name: /invoke_agent/ });

    expect(screen.getByRole("button", { name: "上一页" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "下一页" })).toBeDisabled()
    );
    expect(screen.getByRole("button", { name: "上一页" })).toBeEnabled();
  });

  it("总条数与页码文案在场（共 N 条 · 第 X/Y 页）", async () => {
    stubPagedApi({ 1: [wireItemJson({})] }, 137);
    renderPage();
    await screen.findByRole("button", { name: /invoke_agent/ });
    const pager = screen.getByRole("navigation", { name: "Trace 列表分页" });
    expect(pager).toHaveTextContent("共 137 条");
    expect(pager).toHaveTextContent("第 1/7 页");
  });

  it("取数失败显示错误文案 + 重试按钮（不白屏）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve(JSON.stringify({ detail: "boom" })),
      })
    );
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("取数失败（HTTP 500）：boom");
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });

  it("失败后点重试：恢复到列表，且重试的是失败的那一页（不回第 1 页）", async () => {
    // page=1 正常（total=41 → 3 页）；page=3 首次 500，重试时 200
    let page3Calls = 0;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const m = /^\/api\/traces\?page=(\d+)&page_size=(\d+)$/.exec(url);
      if (!m) return Promise.reject(new Error(`unexpected url: ${url}`));
      const page = Number(m[1]);
      if (page === 3) {
        page3Calls += 1;
        if (page3Calls === 1) {
          return Promise.resolve({
            ok: false,
            status: 500,
            text: () => Promise.resolve(JSON.stringify({ detail: "boom" })),
          });
        }
      }
      const body =
        `{"items":[${wireItemJson({ trace_id: `p${page}`, name: `page${page}` })}],` +
        `"page":${page},"page_size":20,"total":41}`;
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(body) });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    await screen.findByRole("button", { name: /page1/ });
    fireEvent.click(screen.getByRole("button", { name: "3" }));
    await screen.findByRole("alert");

    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    await screen.findByRole("button", { name: /page3/ });
    expect(page3Calls).toBe(2);
    // 重试没有回到第 1 页：请求序列最后一个是 page=3
    const lastUrl = fetchMock.mock.calls.at(-1)?.[0] as string;
    expect(lastUrl).toBe("/api/traces?page=3&page_size=20");
  });

  it("响应页码越界（总数缩水）→ 回落到最后一页，不渲染「第 3/2 页」", async () => {
    // 第 1 页看到 total=41（3 页）；请求第 3 页时 DB 只剩 21 条（2 页），后端回 page=3/items=[]
    // 回落请求 page=2 时真实后端会回 total=21（同一 DB 状态），mock 也必须如此
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        const m = /^\/api\/traces\?page=(\d+)&page_size=(\d+)$/.exec(url);
        if (!m) return Promise.reject(new Error(`unexpected url: ${url}`));
        const page = Number(m[1]);
        let body: string;
        if (page === 1) {
          body = `{"items":[${wireItemJson({ trace_id: "p1", name: "page1" })}],` +
            `"page":1,"page_size":20,"total":41}`;
        } else if (page === 2) {
          // 缩水后的真实状态：共 21 条 → 2 页
          body = `{"items":[${wireItemJson({ trace_id: "p2", name: "page2" })}],` +
            `"page":2,"page_size":20,"total":21}`;
        } else {
          // 越界页：后端仍按请求回 page=3，total 已缩水
          body = `{"items":[],"page":3,"page_size":20,"total":21}`;
        }
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(body) });
      })
    );
    renderPage();

    await screen.findByRole("button", { name: /page1/ });
    fireEvent.click(screen.getByRole("button", { name: "3" }));

    // 回落到 2/2 页
    await waitFor(() => {
      expect(screen.getByRole("navigation", { name: "Trace 列表分页" })).toHaveTextContent("第 2/2 页");
    });
    expect(screen.getByRole("button", { name: /page2/ })).toBeInTheDocument();
    expect(screen.queryByText("暂无 trace")).toBeNull();
  });

  it("同页点按不发重复请求（选中态也不被清空）", async () => {
    // 说明：setPage(同值) 本身是 React 的 no-op，所以「不发请求」这条对同页天然成立；
    // 真正需要守的是「不因同页点击清掉选中」——那会让右栏无谓回退到空态。
    const fetchMock = stubPagedApi({ 1: [wireItemJson({})] }, 41);
    renderPage();
    const row = await screen.findByRole("button", { name: /invoke_agent/ });
    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-pressed", "true");
    const before = fetchMock.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "1" }));

    expect(fetchMock.mock.calls.length).toBe(before);
    expect(row).toHaveAttribute("aria-pressed", "true");
  });

  it("快速连点翻页：慢的旧响应不覆盖新页（序号 + abort 双守卫）", async () => {
    // page=2 挂起，page=3 立即返回；不守卫时 page 2 的后到响应会覆盖 page 3
    let releaseSlow: (() => void) | undefined;
    const slowGate = new Promise<void>((resolve) => (releaseSlow = resolve));
    const wire = (page: number, name: string) =>
      `{"items":[${wireItemJson({ trace_id: `p${page}`, name })}],` +
      `"page":${page},"page_size":20,"total":41}`;

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        const m = /^\/api\/traces\?page=(\d+)&page_size=(\d+)$/.exec(url);
        if (!m) return Promise.reject(new Error(`unexpected url: ${url}`));
        const page = Number(m[1]);
        const body = page === 2 ? wire(2, "slow page2") : wire(page, `page${page}`);
        const resp = { ok: true, status: 200, text: () => Promise.resolve(body) };
        if (page === 2) return slowGate.then(() => resp);
        return Promise.resolve(resp);
      })
    );
    renderPage();

    await screen.findByRole("button", { name: /page1/ });
    fireEvent.click(screen.getByRole("button", { name: "下一页" })); // page 2 挂起
    fireEvent.click(screen.getByRole("button", { name: "3" })); // page 3 立即返回

    await screen.findByRole("button", { name: /page3/ });
    releaseSlow?.();
    // 旧响应落地后不得覆盖：page 3 仍在，page 2 不出现
    await waitFor(() => expect(screen.getByRole("button", { name: /page3/ })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /slow page2/ })).toBeNull();
  });
});

describe("isPageChangeAllowed（翻页准入，越界/同页拒绝）", () => {
  it("合法区间内的异页放行", () => {
    expect(isPageChangeAllowed(2, 1, 3)).toBe(true);
    expect(isPageChangeAllowed(3, 2, 3)).toBe(true);
    expect(isPageChangeAllowed(1, 2, 3)).toBe(true);
  });

  it("越界拒绝：小于 1、大于总页数", () => {
    expect(isPageChangeAllowed(0, 1, 3)).toBe(false);
    expect(isPageChangeAllowed(-1, 1, 3)).toBe(false);
    expect(isPageChangeAllowed(4, 1, 3)).toBe(false);
    // 总数缩水到 1 页时，原第 3 页的越界点击也不再放行
    expect(isPageChangeAllowed(3, 1, 1)).toBe(false);
  });

  it("同页拒绝（不重取、不清选中）", () => {
    expect(isPageChangeAllowed(1, 1, 3)).toBe(false);
    expect(isPageChangeAllowed(2, 2, 3)).toBe(false);
  });
});

describe("totalPagesOf（总页数口径，列表页与分页控件共用）", () => {
  it("向上取整", () => {
    expect(totalPagesOf(21, 20)).toBe(2);
    expect(totalPagesOf(20, 20)).toBe(1);
    expect(totalPagesOf(41, 20)).toBe(3);
  });

  it("至少 1 页（total=0 不出现 0 页）", () => {
    expect(totalPagesOf(0, 20)).toBe(1);
  });
});

describe("pageWindow（页码窗口）", () => {
  it("总页数少时全列", () => {
    expect(pageWindow(1, 3)).toEqual([1, 2, 3]);
    expect(pageWindow(1, 0)).toEqual([]);
  });

  it("当前页居中，最多 5 个", () => {
    expect(pageWindow(5, 10)).toEqual([3, 4, 5, 6, 7]);
  });

  it("两端收敛到合法范围", () => {
    expect(pageWindow(1, 10)).toEqual([1, 2, 3, 4, 5]);
    expect(pageWindow(10, 10)).toEqual([6, 7, 8, 9, 10]);
  });
});
