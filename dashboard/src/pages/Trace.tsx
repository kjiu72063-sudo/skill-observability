/**
 * Trace 区块（M2-04 #19）：左栏 REST 分页列表 + 右栏详情占位。
 *
 * 布局按 #2 决议 IA 第 2 条：列表+详情左右分栏（原型 .trace-split，
 * 左 minmax(300px,380px) / 右自适应）。本票只做列表与选中样式；
 * 详情树归 M2-05（#20），SSE 实时插入归 M2-06。
 *
 * 数据流：REST 快照（GET /api/traces?page=&page_size=20）→ 前端 BigInt 倒序兜底
 * → 渲染。page 是唯一翻页真相，取数副作用绑在 [page, reloadTick] 上——
 * 越界页、重试原页都由状态机保证，不靠事件处理器补丁。
 * 竞态：每次 effect 自建 AbortController，cleanup 即 abort（连点只认最后一次）。
 *
 * 进行中判定 = root end_time_unix_nano 为 null（契约语义），不用前端计时器。
 */

import { useEffect, useState } from "react";

import {
  fetchTraces,
  sortTraceItemsDesc,
  TRACE_PAGE_SIZE,
  type TraceListItem,
} from "../api/traces";
import { ApiError } from "../api/client";
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
  }, [page, reloadTick]);

  const handlePageChange = (next: number) => {
    const totalPages = state.kind === "ready" ? totalPagesOf(state.total, state.pageSize) : 1;
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
            全链路调用树 · 分页快照
            <span className="ep-chip">
              <i>GET</i> /api/traces
            </span>
          </div>
        </div>
      </div>

      <div className="trace-split">
        <div className="card trace-list-card">
          <div className="rail-cap trace-list-cap">TRACE 列表</div>
          <TraceListBody state={state} selectedId={selectedId} onSelect={setSelectedId} onRetry={retry} />
          {/* 一页也显示：默认 demo 只有 1 条 trace，隐藏会让「共 1 条」不可见（票面要求分页控件在场） */}
          {state.kind === "ready" && state.total > 0 ? (
            <TracePager
              page={state.page}
              pageSize={state.pageSize}
              total={state.total}
              onPageChange={handlePageChange}
            />
          ) : null}
        </div>
        <div className="card trace-detail-card">
          <SelectedPlaceholder selectedId={selectedId} state={state} />
        </div>
      </div>
    </section>
  );
}

function TraceListBody({
  state,
  selectedId,
  onSelect,
  onRetry,
}: {
  state: ListState;
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
  if (state.items.length === 0) {
    return <TraceListEmpty title="暂无 trace" hint="跑 python demo.py 产生数据" />;
  }
  return (
    <div className="tlist">
      {state.items.map((item) => (
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

/** 右栏（M2-05 #20 接管详情树；本票只做占位与选中回显）。 */
function SelectedPlaceholder({ selectedId, state }: { selectedId: string | null; state: ListState }) {
  if (selectedId === null) {
    return (
      <TraceListEmpty title="从左侧选择一条 trace" hint="查看 span 树与实时生长" />
    );
  }
  const name =
    state.kind === "ready" ? state.items.find((i) => i.trace_id === selectedId)?.name : undefined;
  return (
    <div className="detail-placeholder">
      <div className="rail-cap detail-cap">SPAN 树</div>
      <div className="detail-selected">
        <span className="detail-selected-id">{selectedId}</span>
        {name ? <span className="detail-selected-name">{name}</span> : null}
      </div>
      <div className="detail-hint">详情建设中（M2-05 span 树 / M2-06 实时生长）</div>
    </div>
  );
}
