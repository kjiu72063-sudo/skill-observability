/**
 * Span 详情卡（M2-05 #20）：attributes 键值表 + events 列表 + 状态/理由 + 审计反链占位。
 *
 * 票面/决议约束：
 * - attributes 与 events **分开**展示；键名含点的完整键原样显示（不解析嵌套，
 *   与后端 json_extract 含点键必须引号路径同源的教训）。
 * - M5：events 为空数组时**不渲染** events 卡（不是渲染空状态）。
 * - 值一律按原样 JSON 序列化后展示（票面：不做字段挑选隐藏），长值靠
 *   `.attr .v` 的 overflow-wrap:anywhere 断行（M2 注意事项，不用 break-all）。
 * - M8 反链：本票只放禁用态占位按钮，跳转在 M2-08 接通。
 *
 * 纯展示：span 由父层传（已选中的那个），无取数逻辑。
 */

import type { SpanEvent, TraceSpan } from "../api/traces";
import { formatSpanDuration, formatSpanStatus, spanPolicy } from "../lib/spanTree";
import { Badge } from "./TraceRow";

/** attributes 值 → 展示文本：字符串原样（不加引号），其余 JSON 序列化。 */
export function attributeValueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (value === undefined) return "—";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** attributes 键值对按后端 JSON 里的插入顺序展示（对象键序即原样）。 */
export function attributeEntries(span: TraceSpan): Array<[string, string]> {
  const attrs = span.attributes;
  if (attrs === null || typeof attrs !== "object") return [];
  return Object.entries(attrs).map(([k, v]) => [k, attributeValueText(v)]);
}

function EventCard({ event }: { event: SpanEvent }) {
  const entries = event.attributes && typeof event.attributes === "object"
    ? Object.entries(event.attributes).map(([k, v]) => [k, attributeValueText(v)] as const)
    : [];
  return (
    <li className="ev">
      <div className="ev-head">
        <span className="ev-name">{event.name ?? "event"}</span>
      </div>
      {entries.length > 0 ? (
        <div className="attr-grid">
          {entries.map(([k, v]) => (
            <div className="attr" key={k}>
              <span className="k">{k}</span>
              <span className="v">{v}</span>
            </div>
          ))}
        </div>
      ) : null}
    </li>
  );
}

export default function SpanDetailCard({ span }: { span: TraceSpan }) {
  const entries = attributeEntries(span);
  const policy = spanPolicy(span);
  const errored = span.status_code === "ERROR";
  const running = span.end_time_unix_nano === null;
  const events = Array.isArray(span.events) ? span.events : [];

  return (
    <div className="span-detail" data-span-detail-id={span.span_id}>
      <div className="detail-head">
        <div className="detail-title">
          <span className="detail-sid">{span.span_id}</span>
          <span className="detail-name">{span.name}</span>
        </div>
        <div className="detail-chips">
          <span className="kd">{span.kind}</span>
          <span className={"detail-dur" + (running ? " running" : "")}>
            {formatSpanDuration(span)}
          </span>
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
        </div>
      </div>

      <div className="detail-status">
        <span className="k">status</span>
        <span className={"v" + (errored ? " err" : "")}>{formatSpanStatus(span)}</span>
      </div>

      {policy.signal === "block" && policy.reason ? (
        <div className="detail-block-reason" role="note">
          <span className="k">拦截理由</span>
          <span className="v">{policy.reason}</span>
        </div>
      ) : null}
      {policy.signal === "observe" && policy.matchedRule ? (
        <div className="detail-observe-note">
          <span className="k">观察期命中</span>
          <span className="v">规则 {policy.matchedRule}（verdict 仍为 allow，仅标记）</span>
        </div>
      ) : null}

      <div className="detail-section">
        <div className="detail-section-cap">ATTRIBUTES · {entries.length}</div>
        {entries.length === 0 ? (
          <div className="detail-none">无 attributes</div>
        ) : (
          <div className="attr-grid">
            {entries.map(([k, v]) => (
              // 键名含点：原样展示，直接字符串匹配（不解析嵌套）
              <div className="attr" key={k} data-attr-key={k}>
                <span className="k">{k}</span>
                <span className="v">{v}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* M5：空数组不渲染卡（连标题都不出现） */}
      {events.length > 0 ? (
        <div className="detail-section">
          <div className="detail-section-cap">EVENTS · {events.length}</div>
          <ul className="ev-list">
            {events.map((event, i) => (
              <EventCard key={`${event.name ?? "event"}-${i}`} event={event} />
            ))}
          </ul>
        </div>
      ) : null}

      <div className="detail-actions">
        <button
          type="button"
          className="btn"
          disabled
          title="反链闭环在 M2-08 接通（审计区块页此时已存在）"
        >
          查看审计行
        </button>
      </div>
    </div>
  );
}
