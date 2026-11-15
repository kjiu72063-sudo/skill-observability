/**
 * Span 详情卡（M2-05 #20）：attributes 键值表 + events 列表 + 状态/理由 + 审计反链占位。
 *
 * 票面/决议约束：
 * - attributes 与 events **分开**展示；键名含点的完整键原样显示（不解析嵌套，
 *   与后端 json_extract 含点键必须引号路径同源的教训）。
 * - M5：events 为空数组时**不渲染** events 卡（不是渲染空状态）。
 * - 值一律按原样 JSON 序列化后展示（票面：不做字段挑选隐藏），长值靠
 *   `.attr .v` 的 overflow-wrap:anywhere 断行（M2 注意事项，不用 break-all）。
 * - M8 反链：仅 execute_tool span 按 trace_id 拉审计，再按 span_id 精确定位。
 */

import { useEffect, useRef, useState } from "react";
import { Navigate } from "react-router-dom";

import { fetchAudits } from "../api/audits";
import { ApiError } from "../api/client";
import type { SpanEvent, TraceSpan } from "../api/traces";
import { auditLocation } from "../lib/urlState";
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
  const canOpenAudit = span.attributes["gen_ai.operation.name"] === "execute_tool";
  const [lookupState, setLookupState] = useState<"idle" | "loading" | "error">("idle");
  const [lookupError, setLookupError] = useState("");
  const [auditTarget, setAuditTarget] = useState<string | null>(null);
  const lookupController = useRef<AbortController | null>(null);

  useEffect(() => {
    lookupController.current?.abort();
    setLookupState("idle");
    setLookupError("");
    setAuditTarget(null);
    return () => lookupController.current?.abort();
  }, [span.span_id]);

  const openAudit = async () => {
    lookupController.current?.abort();
    const ctrl = new AbortController();
    lookupController.current = ctrl;
    setLookupState("loading");
    setLookupError("");

    try {
      let page = 1;
      while (true) {
        const body = await fetchAudits(page, "all", 100, ctrl.signal, span.trace_id);
        const match = body.items.find((item) => item.span_id === span.span_id);
        if (match) {
          setAuditTarget(auditLocation(match.id));
          setLookupState("idle");
          return;
        }
        if (page * body.page_size >= body.total) break;
        page += 1;
      }
      setLookupState("error");
      setLookupError("未找到与当前 span 匹配的审计行");
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setLookupState("error");
      setLookupError(
        err instanceof ApiError
          ? `查找审计行失败（HTTP ${err.status}）：${err.detail}`
          : err instanceof Error
            ? `查找审计行失败：${err.message}`
            : "查找审计行失败"
      );
    }
  };

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

      {canOpenAudit ? (
        <div className="detail-actions">
          <button
            type="button"
            className="btn"
            disabled={lookupState === "loading"}
            onClick={openAudit}
          >
            {lookupState === "loading" ? "查找审计行…" : "查看审计行"}
          </button>
          {lookupState === "error" ? <span role="alert">{lookupError}</span> : null}
          {auditTarget ? <Navigate to={auditTarget} /> : null}
        </div>
      ) : null}
    </div>
  );
}
