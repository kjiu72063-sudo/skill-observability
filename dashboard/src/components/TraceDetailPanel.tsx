/**
 * Trace 详情面板（M2-05 #20）：右栏主体 = trace 头 + 三层 span 树 + 选中 span 详情卡。
 *
 * 数据流：父层给 selectedId → 本组件 `GET /api/traces/{id}`（契约 §2.2 平铺 spans）
 * → buildSpanTree 前端建树。SSE 实时生长归 M2-06（本票 REST 快照）。
 * 竞态：每次 effect 自建 AbortController + 世代守卫——快速切换行只认最后一次。
 *
 * M3：trace_id 全值 hover（title）+ 一键复制，复制结果就地回显「已复制」/「复制失败」。
 * 树选中态独立于左栏选中：切换左栏 trace 时清空 span 选中（不同 trace 的 span_id 无意义）。
 */

import { useEffect, useRef, useState } from "react";

import { ApiError } from "../api/client";
import { fetchTraceDetail, type TraceDetail, type TraceListItem } from "../api/traces";
import SpanDetailCard from "./SpanDetailCard";
import SpanTree from "./SpanTree";
import { TraceListEmpty } from "./TraceRow";
import { copyText } from "../lib/clipboard";
import { buildSpanTree } from "../lib/spanTree";

type DetailState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; detail: TraceDetail };

export default function TraceDetailPanel({
  traceId,
  listItem,
}: {
  traceId: string;
  /** 列表行数据：树头直接复用（名称/agent/时间无需二次推算） */
  listItem?: TraceListItem;
}) {
  const [state, setState] = useState<DetailState>({ kind: "loading" });
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "ok" | "fail">("idle");
  const [reloadTick, setReloadTick] = useState(0);
  const copyTimer = useRef<number | undefined>(undefined);

  // 卸载时清掉复制反馈定时器（否则卸载后 setState 是空跑，且计时器泄漏 2s）
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  useEffect(() => {
    const ctrl = new AbortController();
    let alive = true;
    setState({ kind: "loading" });
    // 换 trace 时 span 选中必须清空（旧 id 在新树里不存在，留着会渲染出「无选中」的错觉）
    setSelectedSpanId(null);
    setCopyState("idle");
    fetchTraceDetail(traceId, ctrl.signal)
      .then((detail) => {
        if (!alive) return;
        setState({ kind: "ready", detail });
      })
      .catch((err: unknown) => {
        if (!alive) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        const message =
          err instanceof ApiError
            ? err.status === 404
              ? "trace 不存在（可能已被重置数据库移除）"
              : `取数失败（HTTP ${err.status}）：${err.detail}`
            : err instanceof Error
              ? err.message
              : "取数失败";
        setState({ kind: "error", message });
      });
    return () => {
      alive = false;
      ctrl.abort();
    };
  }, [traceId, reloadTick]);

  const tree = state.kind === "ready" ? buildSpanTree(state.detail.spans) : null;
  const selectedSpan =
    state.kind === "ready" && selectedSpanId !== null
      ? (state.detail.spans.find((s) => s.span_id === selectedSpanId) ?? null)
      : null;

  const handleCopy = async () => {
    const ok = await copyText(traceId);
    setCopyState(ok ? "ok" : "fail");
    // 反馈 2s 后复位，避免一直挂着「已复制」；切 trace/卸载时由 copyTimer 清掉
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopyState("idle"), 2000);
  };

  const spanCount = state.kind === "ready" ? state.detail.spans.length : null;

  return (
    <div className="trace-detail">
      <div className="detail-head-bar">
        <div className="rail-cap detail-cap">SPAN 树</div>
        <div className="detail-meta">
          {spanCount !== null ? (
            <span className="detail-count">共 {spanCount} 个 span · 服务端平铺 · 前端建树</span>
          ) : null}
        </div>
      </div>

      <div className="trace-tid-row">
        {/* M3：全值在 DOM 里（hover title + 复制），不截断 */}
        <code className="trace-tid" title={traceId}>
          {traceId}
        </code>
        <button
          type="button"
          className="btn btn-copy"
          onClick={handleCopy}
          aria-label="复制 trace_id"
        >
          {copyState === "ok" ? "已复制" : copyState === "fail" ? "复制失败" : "复制"}
        </button>
        {listItem ? <span className="trace-agent">{listItem.agent_id ?? "—"}</span> : null}
      </div>

      {state.kind === "loading" ? (
        <div className="tlist-state" role="status" aria-live="polite">
          加载 span 树…
        </div>
      ) : null}

      {state.kind === "error" ? (
        <div className="tlist-state tlist-error">
          <div role="alert">{state.message}</div>
          <button
            type="button"
            className="pager-btn retry-btn"
            onClick={() => setReloadTick((t) => t + 1)}
          >
            重试
          </button>
        </div>
      ) : null}

      {tree ? (
        <SpanTree
          roots={tree.roots}
          orphanCount={tree.orphanCount}
          selectedId={selectedSpanId}
          onSelectSpan={setSelectedSpanId}
        />
      ) : null}

      {spanCount === 0 ? (
        <TraceListEmpty title="本 trace 暂无 span" hint="进行中的 trace 可能尚未落库" />
      ) : null}

      {selectedSpan ? <SpanDetailCard span={selectedSpan} /> : null}
    </div>
  );
}
