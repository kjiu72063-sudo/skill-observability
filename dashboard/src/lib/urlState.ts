/** 跨区块定位 URL 的唯一构造与解析入口。传给 React Router 的是 HashRouter 内部目标。 */

const TRACE_PATH = "/trace";
const AUDIT_PATH = "/audit";
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const AUDIT_ID_PATTERN = /^[1-9][0-9]*$/;

function singleParam(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  return values.length === 1 ? values[0] : null;
}

/** 构造 `#/trace?trace=<trace_id>` 对应的 React Router 内部目标。 */
export function traceLocation(traceId: string): string {
  const query = new URLSearchParams({ trace: traceId });
  return `${TRACE_PATH}?${query.toString()}`;
}

/** 严格解析 trace 定位参数：只接受单个、32 位小写十六进制 trace_id。 */
export function parseTraceLocation(search: string): string | null {
  const traceId = singleParam(new URLSearchParams(search), "trace");
  return traceId !== null && TRACE_ID_PATTERN.test(traceId) ? traceId : null;
}

/** 清除 Trace 定位参数时使用。 */
export function traceBaseLocation(): string {
  return TRACE_PATH;
}

/** 构造 `#/audit?audit=<audit_id>&expanded=1` 对应的 React Router 内部目标。 */
export function auditLocation(auditId: number): string {
  const query = new URLSearchParams({ audit: String(auditId), expanded: "1" });
  return `${AUDIT_PATH}?${query.toString()}`;
}

/** 严格解析审计定位：audit 必须是单个正整数，expanded 必须是单个字面量 `1`。 */
export function parseAuditLocation(search: string): number | null {
  const params = new URLSearchParams(search);
  const auditId = singleParam(params, "audit");
  const expanded = singleParam(params, "expanded");
  if (auditId === null || !AUDIT_ID_PATTERN.test(auditId) || expanded !== "1") return null;
  const parsed = Number(auditId);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** 清除审计定位参数时使用。 */
export function auditBaseLocation(): string {
  return AUDIT_PATH;
}
