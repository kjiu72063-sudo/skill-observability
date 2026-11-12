/**
 * Trace 列表行 + 徽标族（M2-04 #19）：对齐 #2 原型 `.trow`（kanban-infoarch-wireframe.html）。
 *
 * 行要素（票面）：名称（root span name）/ agent_id / 开始时间 / 状态 / span 数 / blocked 徽标。
 * - blocked 徽标 = 红「拦截」（S2/S3 色彩语义：红=拦截）；
 * - 进行中徽标 = root end_time_unix_nano 为 null（契约语义）。
 *   取色待裁决：票面写「琥珀呼吸态」，但 CONTEXT.md 把琥珀钉给「观察期命中」，
 *   #2 原型的进行中徽标（.b-run）是青色；本实现从原型取青，避免两义撞色。
 *   该偏离已在 #19 决议评论留痕，等用户拍板（改成琥珀只需换 tone="observe"）。
 * - agent_id 徽标列必须在场（#2 M4：审计行恢复 agent_id 维度，列表先立榜样）。
 * 纯展示组件：不取数、不管选中。选中态由父层传 selected + onSelect。
 */

import type { TraceListItem } from "../api/traces";
import { formatNanoTime, formatTraceDate, isInProgress } from "../api/traces";

/** 徽标族：红=拦截 / 琥珀=观察期 / 灰=放行 / 青=进行中（原型 .b 系列）。 */
export function Badge({
  tone,
  children,
  pulse = false,
}: {
  tone: "block" | "observe" | "allow" | "run";
  children: React.ReactNode;
  pulse?: boolean;
}) {
  return (
    <span className={`b b-${tone}${pulse ? " b-pulse" : ""}`} data-tone={tone}>
      {children}
    </span>
  );
}

export default function TraceRow({
  item,
  selected,
  onSelect,
}: {
  item: TraceListItem;
  selected: boolean;
  onSelect: (traceId: string) => void;
}) {
  const running = isInProgress(item);
  return (
    <button
      type="button"
      className={`trow${selected ? " selected" : ""}`}
      aria-pressed={selected}
      data-trace-id={item.trace_id}
      onClick={() => onSelect(item.trace_id)}
    >
      <span className="trow-name">{item.name}</span>
      <span className="trow-meta">
        {/* agent_id 徽标（#2 M4）：缺值显示「—」，列位不可省 */}
        <span className="agent-chip" title="agent_id">
          {item.agent_id ?? "—"}
        </span>
        <span className="trow-time">
          {formatTraceDate(item.start_time_unix_nano)} {formatNanoTime(item.start_time_unix_nano)}
        </span>
        {item.blocked ? <Badge tone="block">拦截</Badge> : null}
        {running ? (
          <Badge tone="run" pulse>
            进行中
          </Badge>
        ) : null}
        <span className="spans-n">{item.span_count} 个 span</span>
      </span>
      <span className="trow-bar" aria-hidden="true" />
    </button>
  );
}

/** 空态（原型 .empty）：未跑场景 / 删库重启时的落点，不白屏（票面验收）。 */
export function TraceListEmpty({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <path d="m21 21-4.3-4.3" strokeLinecap="round" />
      </svg>
      <div className="empty-title">{title}</div>
      <div>{hint}</div>
    </div>
  );
}
