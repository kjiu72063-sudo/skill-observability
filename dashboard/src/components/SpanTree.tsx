/**
 * Span 树（M2-05 #20）：把 buildSpanTree 的森林渲染成原型 `.tnode` 结构。
 *
 * 节点要素（票面）：名称 / kind / 时长（end-start，一位小数）/ 状态 / 命中徽标。
 * - ERROR 红行 + 红「ERROR」徽标；block 再叠红「拦截」；
 * - 观察期命中 = 琥珀「观察期」；放行 = 灰「放行」（三信号色语义，CONTEXT.md）；
 * - 进行中（end 为 null）= 虚线行 + spinner + 「进行中」，不贴 verdict 徽标。
 * 孤儿节点（父不在平铺集）在节点上打「孤儿」徽标 + 顶部横幅告警——显式可见，不静默丢。
 *
 * 纯展示：树结构与选中态由父层给，本组件只回调 onSelectSpan。
 */

import type { SpanNode } from "../lib/spanTree";
import { formatSpanDuration, spanPolicy } from "../lib/spanTree";
import { Badge } from "./TraceRow";

function SpanNodeRow({
  node,
  depth,
  selectedId,
  onSelectSpan,
}: {
  node: SpanNode;
  depth: number;
  selectedId: string | null;
  onSelectSpan: (spanId: string) => void;
}) {
  const { span } = node;
  const running = span.end_time_unix_nano === null;
  const errored = span.status_code === "ERROR";
  const policy = spanPolicy(span);
  const selected = span.span_id === selectedId;

  return (
    <li className="tnode">
      <button
        type="button"
        className={
          "tnode-row" +
          (running ? " running" : "") +
          (errored ? " err" : "") +
          (selected ? " selected" : "")
        }
        aria-pressed={selected}
        aria-label={`span ${span.name}${running ? "（进行中）" : ""}${errored ? "（ERROR）" : ""}`}
        data-span-id={span.span_id}
        data-depth={depth}
        onClick={() => onSelectSpan(span.span_id)}
      >
        {running ? <span className="running-spinner" aria-hidden="true" /> : null}
        <span className="nm">{span.name}</span>
        <span className="kd">{span.kind}</span>
        <span className="dur">{formatSpanDuration(span)}</span>
        {/* 状态与命中是两个维度（原型同时给）：ERROR = span 状态，拦截 = 策略命中 */}
        {errored ? <Badge tone="block">ERROR</Badge> : null}
        {policy.signal === "block" ? <Badge tone="block">拦截</Badge> : null}
        {policy.signal === "observe" ? <Badge tone="observe">观察期</Badge> : null}
        {policy.signal === "allow" ? (
          <span
            className="b b-allow"
            title="推断：未命中规则的成功调用不写 verdict（契约 §3.4），放行由「已结束且无拦截证据」得出"
          >
            放行
          </span>
        ) : null}
        {/* 孤儿是数据完整性问题、不是 verdict——用中性徽标，避免占用三信号色语义 */}
        {node.orphan ? <span className="b b-neutral">孤儿</span> : null}
      </button>
      {node.children.length > 0 ? (
        <ul>
          {node.children.map((child) => (
            <SpanNodeRow
              key={child.span.span_id}
              node={child}
              depth={depth + 1}
              selectedId={selectedId}
              onSelectSpan={onSelectSpan}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export default function SpanTree({
  roots,
  missingParentCount,
  cycleCount,
  selectedId,
  onSelectSpan,
}: {
  roots: SpanNode[];
  missingParentCount: number;
  cycleCount: number;
  selectedId: string | null;
  onSelectSpan: (spanId: string) => void;
}) {
  // 空森林不在这里出空态文案：详情面板统一给「本 trace 暂无 span」空态（避免双份文案）
  if (roots.length === 0) return null;
  // 两类异常分开说：父缺失是「父不在本 trace 内」，环是「父在但父子成环」——
  // 合成一句会把后者说错（评审 #20 第一拍 P3）。
  const warnings: string[] = [];
  if (missingParentCount > 0) {
    warnings.push(
      `${missingParentCount} 个 span 找不到父节点（parent_span_id 不在本 trace 内），已并列挂在根层——数据可能不完整。`
    );
  }
  if (cycleCount > 0) {
    warnings.push(
      `${cycleCount} 个 span 的父子关系成环（parent_span_id 互相指向），已切断环边并列挂在根层——数据异常，请检查上报端。`
    );
  }
  return (
    <div className="tree">
      {warnings.length > 0 ? (
        <div className="tree-warn" role="alert">
          {warnings.map((w) => (
            <div key={w}>{w}</div>
          ))}
        </div>
      ) : null}
      <ul>
        {roots.map((node) => (
          <SpanNodeRow
            key={node.span.span_id}
            node={node}
            depth={0}
            selectedId={selectedId}
            onSelectSpan={onSelectSpan}
          />
        ))}
      </ul>
    </div>
  );
}
