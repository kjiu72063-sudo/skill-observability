/**
 * 审计表格（M2-07 #22）：对齐 #2 原型 `.audit-head` / `.audit-row`。
 *
 * 行要素（票面）：时间 / agent_id（#2 M4：维度必须在场）/ tool_name / verdict 徽标 /
 * 命中规则 / 理由 / 截断标记。
 *
 * 行只可选中高亮、**不可展开**（展开 payload 与「→ trace」跳转归 M2-08）：
 * 用 `<button aria-pressed>` 而不是可点击 `<div>`，键盘可达、选中态有语义。
 * 列用 CSS grid 对齐表头（原型同款），不用 `<table>` 是为了与原型行样式一致。
 */

import type { AuditListItem } from "../api/audits";
import { formatAuditTime } from "../api/audits";
import { AuditVerdictBadges, TruncatedMark } from "./AuditVerdictBadges";

export function AuditTableEmpty({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <path d="M4 6h16M4 12h16M4 18h10" strokeLinecap="round" />
      </svg>
      <div className="empty-title">{title}</div>
      <div>{hint}</div>
    </div>
  );
}

/** 表头：与行同网格（原型 `.audit-head`）。小屏隐藏（行改双列堆叠）。 */
export function AuditTableHead() {
  return (
    <div className="audit-head" aria-hidden="true">
      <span>#</span>
      <span>时间</span>
      <span>工具</span>
      <span>verdict</span>
      <span>命中规则 / 理由</span>
      <span />
    </div>
  );
}

export default function AuditTable({
  items,
  selectedId,
  onSelect,
}: {
  items: readonly AuditListItem[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
}) {
  return (
    <div className="audit-body">
      <AuditTableHead />
      {items.map((row) => {
        const selected = row.id === selectedId;
        return (
          <button
            key={row.id}
            type="button"
            className={`audit-row${selected ? " selected" : ""}`}
            aria-pressed={selected}
            data-audit-id={row.id}
            onClick={() => onSelect(selected ? null : row.id)}
          >
            <span className="aid">#{row.id}</span>
            <span className="atime">{formatAuditTime(row.created_at_unix_nano)}</span>
            <span className="atool">
              <span className="atool-name">{row.tool_name}</span>
              {/* #2 M4：agent_id 维度必须在场 */}
              <span className="agent-chip" title="agent_id">
                {row.agent_id}
              </span>
            </span>
            <span className="abadges">
              <AuditVerdictBadges row={row} />
              {row.payload_truncated ? <TruncatedMark /> : null}
            </span>
            <span className="arule">
              {row.rule_id ? (
                <span className="arule-id">{row.rule_id}</span>
              ) : (
                <span className="arule-none">—</span>
              )}
              <small>{row.reason ?? "未命中任何规则"}</small>
            </span>
            <span className="aselect" aria-hidden="true">
              {selected ? "已选中" : ""}
            </span>
          </button>
        );
      })}
    </div>
  );
}
