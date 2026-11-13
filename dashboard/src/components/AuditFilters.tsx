/**
 * 四段筛选（M2-07 #22）：全部 / 拦截 / 放行 / 观察期——对齐 #2 原型 `.seg`。
 *
 * 组件只负责「点哪个段」，不拼查询参数：段 → 参数的映射在 api/audits.ts 的
 * `auditQuery`（口径唯一出自服务端，这里不做任何过滤计算）。
 * 切换由父层处理（含页码重置到 1）。
 */

import { AUDIT_FILTERS, type AuditFilter } from "../api/audits";

export default function AuditFilters({
  value,
  onChange,
}: {
  value: AuditFilter;
  onChange: (next: AuditFilter) => void;
}) {
  return (
    <div className="audit-filters">
      <span className="audit-fgroup">筛选</span>
      <div className="seg" role="group" aria-label="审计筛选">
        {AUDIT_FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            className={f.key === value ? "on" : undefined}
            aria-pressed={f.key === value}
            onClick={() => onChange(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>
    </div>
  );
}
