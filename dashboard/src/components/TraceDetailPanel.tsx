/**
 * Trace 详情面板（M2-05 #20）：右栏主体 = trace 头 + 三层 span 树 + 选中 span 详情卡。
 *
 * 数据流（M2-06 #21 起）：span 由实时状态层供给——REST 初值打底 + SSE 增量合并
 * （traceStore.getDetailView），本组件不再自取。树渲染与详情卡逻辑不变。
 * 竞态与去重归状态层（请求去重 / 世代守卫 / 按 span_id upsert）。
 *
 * M3：trace_id 全值 hover（title）+ 一键复制，复制结果就地回显「已复制」/「复制失败」。
 * 树选中态独立于左栏选中：切换左栏 trace 时清空 span 选中（不同 trace 的 span_id 无意义）。
 */

import { useEffect, useRef, useState } from "react";

import type { TraceListItem } from "../api/traces";
import SpanDetailCard from "./SpanDetailCard";
import SpanTree from "./SpanTree";
import { TraceListEmpty } from "./TraceRow";
import { buildSpanTree } from "../lib/spanTree";
import { traceStore, useTraceDetailView } from "../lib/traceStore";

/**
 * 复制文本（M3）：`navigator.clipboard` 优先（127.0.0.1 属安全上下文），
 * 非安全上下文/权限拒绝时回退 textarea + execCommand。返回是否成功——
 * 展示层据此给「已复制 / 复制失败」，绝不假装成功。
 * 回退分支用 try/finally：execCommand 抛异常也不能把隐藏 textarea 留在 DOM 里。
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 权限拒绝/浏览器策略：走回退
  }

  const area = document.createElement("textarea");
  try {
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

export default function TraceDetailPanel({
  traceId,
  listItem,
}: {
  traceId: string;
  /** 列表行数据：树头直接复用（名称/agent/时间无需二次推算） */
  listItem?: TraceListItem;
}) {
  // 状态层供给：REST 打底 + SSE 增量（#21）。requestTraceDetail 由 hook 在 traceId 变化时触发。
  const state = useTraceDetailView(traceId);
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "ok" | "fail">("idle");
  const copyTimer = useRef<number | undefined>(undefined);

  // 卸载时清掉复制反馈定时器（否则卸载后 setState 是空跑，且计时器泄漏 2s）
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  // 换 trace 时 span 选中必须清空（旧 id 在新树里不存在，留着会渲染出「无选中」的错觉）
  useEffect(() => {
    setSelectedSpanId(null);
    setCopyState("idle");
  }, [traceId]);

  const spans = state.kind === "ready" ? state.spans : [];
  const tree = state.kind === "ready" ? buildSpanTree(spans) : null;
  const selectedSpan =
    selectedSpanId !== null ? (spans.find((s) => s.span_id === selectedSpanId) ?? null) : null;

  const handleCopy = async () => {
    const ok = await copyText(traceId);
    setCopyState(ok ? "ok" : "fail");
    // 反馈 2s 后复位，避免一直挂着「已复制」；切 trace/卸载时由 copyTimer 清掉
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopyState("idle"), 2000);
  };

  const spanCount = state.kind === "ready" ? spans.length : null;

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
            onClick={() => traceStore.retryTraceDetail(traceId)}
          >
            重试
          </button>
        </div>
      ) : null}

      {tree ? (
        <SpanTree
          roots={tree.roots}
          missingParentCount={tree.missingParentCount}
          cycleCount={tree.cycleCount}
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
