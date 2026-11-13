/**
 * verdict 徽标 + 截断标记（M2-07 #22）：三信号色语义（CONTEXT.md 看板术语）。
 *
 * - 红「拦截」= verdict=block；
 * - 灰「放行」= verdict=allow 且未命中观察期规则；
 * - 琥珀「观察期命中」= verdict=allow 且 action=audit——**文案按 #2 决议 S2 统一**
 *   （不写「警告」：观察期规则的本意就是先观察、不告警）。
 *
 * 观察期命中行按原型与 verdict 徽标并列显示（灰「放行」+ 琥珀「观察期命中」）：
 * 两者说的是不同事实——调用没被拦（放行）、命中了一条 audit 规则（观察期）。
 * 复用 Trace 区块已定的 `.b` 徽标族样式（全局，见 Trace.css），不重造一套。
 */

import { Badge } from "./TraceRow";
import { verdictTone, type AuditListItem } from "../api/audits";

/** 行内 verdict 徽标组：block 只出一枚；allow 出一枚放行，观察期再叠一枚。 */
export function AuditVerdictBadges({
  row,
}: {
  row: Pick<AuditListItem, "verdict" | "action">;
}) {
  const tone = verdictTone(row);
  return (
    <span className="audit-badges">
      {tone === "block" ? <Badge tone="block">拦截</Badge> : <Badge tone="allow">放行</Badge>}
      {tone === "observe" ? <Badge tone="observe">观察期命中</Badge> : null}
    </span>
  );
}

/** payload 被 8KB 上限截断的标记（契约 §3.1）——数据完整性问题，不占三信号色。 */
export function TruncatedMark() {
  return (
    <span className="b b-neutral" title="payload 超过 8KB 上限，已截断（payload_truncated=1）">
      截断
    </span>
  );
}
