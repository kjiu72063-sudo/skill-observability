/**
 * Trace 区块（M2-04 #19 列表 + M2-05 #20 详情 + M2-06 #21 实时）：
 * 左栏 REST 分页列表 + 右栏 span 树详情，两者都由实时状态层供给增量。
 *
 * 布局按 #2 决议 IA 第 2 条：列表+详情左右分栏（原型 .trace-split，
 * 左 minmax(300px,380px) / 右自适应）。
 *
 * 数据流：REST 快照（GET /api/traces?page=&page_size=20）打底 → 第 1 页叠加
 * SSE 增量（traceStore，按 span_id 幂等 upsert）→ 前端 BigInt 倒序兜底 → 渲染。
 * page 是唯一翻页真相，取数副作用绑在 [page, reloadTick] 上——越界页、重试原页
 * 都由状态机保证，不靠事件处理器补丁。
 * 实时合并只作用第 1 页（page≠1 时只更新徽标，翻回第 1 页以 REST 重取为准）。
 * 竞态：每次 effect 自建 AbortController，cleanup 即 abort（连点只认最后一次）。
 *
 * 进行中判定 = root end_time_unix_nano 为 null（契约语义），不用前端计时器。
 * 断线：EventSource 的 error 态只显示顶部黄条，重连交给浏览器原生 Last-Event-ID。
 */

import { useEffect, useMemo, useState } from "react";

import {
  fetchTraces,
  sortTraceItemsDesc,
  TRACE_PAGE_SIZE,
  type TraceListItem,
} from "../api/traces";
import { ApiError } from "../api/client";
import {
  mergeLiveTraceList,
  useLiveTraceRows,
  useTraceStreamResyncCount,
  useTraceStreamStatus,
} from "../lib/traceStore";
import TraceDetailPanel from "../components/TraceDetailPanel";
import TracePager, { totalPagesOf } from "../components/TracePager";
import TraceRow, { TraceListEmpty } from "../components/TraceRow";
import "./Trace.css";

type ListState =
  | { kind: "loading" }
  | { kind: "error"; message: string; page: number }
  | { kind: "ready"; items: TraceListItem[]; page: number; pageSize: number; total: number };

/** 翻页准入：越界 / 同页一律拒绝（同页点击不该清选中、不该重取）。 */
export function isPageChangeAllowed(next: number, current: number, totalPages: number): boolean {
  return next >= 1 && next <= totalPages && next !== current;
}

export default function TracePage() {
  // 受控页码：翻页只改这里，越界/同页由 handlePageChange 挡在事件层，
  // 响应里的 total 缩水由 effect 里的「回落到最后一页」兜底。
  const [page, setPage] = useState(1);
  // 重试同一页：page 不变也要重新触发 effect
  const [reloadTick, setReloadTick] = useState(0);
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 实时增量（第 1 页合并用）：每来一条 SSE 事件 +1 版本，列表/徽标随之重算
  const liveRows = useLiveTraceRows();
  // 重连成功 = 浏览器刚用 Last-Event-ID 续传完。若断线期间服务重启过（demo.py 每次
  // 启动删库），event_log 的 id 从头计数，旧游标大于新库所有 id → 续传事件被服务端
  // 判「已回放」丢弃，只靠 SSE 会留永久空洞。故重连后重取一次 REST（同一 effect）。
  const resyncCount = useTraceStreamResyncCount();

  useEffect(() => {
    const ctrl = new AbortController();
    // 世代守卫：abort 只终止真实网络层；已 resolve 的旧响应仍会进 then。
    // 用 effect 局部的 alive 标记把「本世代是否仍是当前页」判准（比 page 闭包更稳：
    // 越界回落会 setPage 触发换代，旧世代的写入必须一并作废）。
    let alive = true;
    setState((prev) => (prev.kind === "ready" ? prev : { kind: "loading" }));
    fetchTraces(page, TRACE_PAGE_SIZE, ctrl.signal)
      .then((body) => {
        if (!alive) return;
        const totalPages = totalPagesOf(body.total, body.page_size);
        if (body.page > totalPages) {
          // DB 重置/总数缩水：请求页已越界，回落到最后一页（不渲染「第 3/2 页」）
          setPage(totalPages);
          return;
        }
        setState({
          kind: "ready",
          items: sortTraceItemsDesc(body.items),
          page: body.page,
          pageSize: body.page_size,
          total: body.total,
        });
      })
      .catch((err: unknown) => {
        if (!alive) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        const message =
          err instanceof ApiError
            ? `取数失败（HTTP ${err.status}）：${err.detail}`
            : err instanceof Error
              ? err.message
              : "取数失败";
        setState({ kind: "error", message, page });
      });
    return () => {
      alive = false;
      ctrl.abort();
    };
  }, [page, reloadTick, resyncCount]);

  // 第 1 页 + 实时增量；page≠1 只保留 REST（票面：翻回第 1 页以 REST 重取为准）。
  // inserted 用于修正显示总数：新 trace 尚未出现在这次 REST 快照里。
  const { items: viewItems, inserted } = useMemo(() => {
    if (state.kind !== "ready") return { items: [] as TraceListItem[], inserted: 0 };
    if (state.page !== 1) return { items: state.items, inserted: 0 };
    return mergeLiveTraceList(state.items, liveRows, state.pageSize);
  }, [state, liveRows]);

  const total = state.kind === "ready" ? state.total + inserted : 0;

  const handlePageChange = (next: number) => {
    const totalPages = state.kind === "ready" ? totalPagesOf(total, state.pageSize) : 1;
    if (!isPageChangeAllowed(next, page, totalPages)) return;
    // 翻页清空选中：跨页残留的选中行会让右栏与列表不同页，语义错乱（详情联动归 #20）
    setSelectedId(null);
    setPage(next);
  };

  const retry = () => {
    // 重试回到失败的那一页（错误态自带 page；不是恒回第 1 页）
    if (state.kind === "error") setPage(state.page);
    setReloadTick((t) => t + 1);
  };

  return (
    <section>
      <div className="view-head">
        <div>
          <h2 className="page-title">Trace</h2>
          <div className="view-desc">
            全链路调用树 · 实时生长
            <span className="ep-chip">
              <i>GET</i> /api/traces
            </span>
            <span className="ep-chip">
              <i>SSE</i> /api/events
            </span>
          </div>
        </div>
      </div>

      <StreamBanner />

      <div className="trace-split">
        <div className="card trace-list-card">
          <div className="rail-cap trace-list-cap">TRACE 列表</div>
          <TraceListBody
            state={state}
            items={viewItems}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onRetry={retry}
          />
          {/* 一页也显示：默认 demo 只有 1 条 trace，隐藏会让「共 1 条」不可见（票面要求分页控件在场） */}
          {state.kind === "ready" && total > 0 ? (
            <TracePager
              page={state.page}
              pageSize={state.pageSize}
              total={total}
              onPageChange={handlePageChange}
            />
          ) : null}
        </div>
        <div className="card trace-detail-card">
          <TraceDetailBody selectedId={selectedId} listItems={viewItems} />
        </div>
      </div>
    </section>
  );
}

/**
 * 断线黄条（票面验收：服务停 → 顶部黄条 + 浏览器原生自动重连）。
 * static（无 EventSource 环境）与正常态不渲染；错误态由 EventSource 自身重试，
 * 恢复时 `onopen` 会把状态翻回 open、黄条自动消失。
 */
function StreamBanner() {
  const status = useTraceStreamStatus();
  if (status !== "error") return null;
  return (
    <div className="live-banner" role="status" aria-live="polite">
      实时连接中断，浏览器正在自动重连（恢复后事件按 Last-Event-ID 补齐）
    </div>
  );
}

function TraceListBody({
  state,
  items,
  selectedId,
  onSelect,
  onRetry,
}: {
  state: ListState;
  items: TraceListItem[];
  selectedId: string | null;
  onSelect: (traceId: string) => void;
  onRetry: () => void;
}) {
  if (state.kind === "loading") {
    return (
      <div className="tlist-state" role="status" aria-live="polite">
        加载中…
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="tlist-state tlist-error">
        {/* alert 只包文案：读屏不该把可交互按钮当警告内容一起播报 */}
        <div role="alert">{state.message}</div>
        <button type="button" className="pager-btn retry-btn" onClick={onRetry}>
          重试
        </button>
      </div>
    );
  }
  if (items.length === 0) {
    return <TraceListEmpty title="暂无 trace" hint="跑 python demo.py 产生数据" />;
  }
  return (
    <div className="tlist">
      {items.map((item) => (
        <TraceRow
          key={item.trace_id}
          item={item}
          selected={item.trace_id === selectedId}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

/** 右栏（M2-05 #20 / #21）：未选中 → 空态；选中 → span 树详情（状态层供给 spans）。 */
function TraceDetailBody({
  selectedId,
  listItems,
}: {
  selectedId: string | null;
  listItems: readonly TraceListItem[];
}) {
  if (selectedId === null) {
    return <TraceListEmpty title="从左侧选择一条 trace" hint="查看 span 树与实时生长" />;
  }
  const listItem = listItems.find((i) => i.trace_id === selectedId);
  return <TraceDetailPanel traceId={selectedId} listItem={listItem} />;
}
