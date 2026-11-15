import type { AuditPayload } from "../api/audits";

export default function AuditPayloadPanel({
  payload,
  truncated,
}: {
  payload: AuditPayload;
  truncated: boolean;
}) {
  return (
    <section className="audit-payload" aria-label="审计 payload">
      <div className="audit-payload-head">
        <span>payload</span>
        {truncated ? <strong className="audit-payload-truncated">已截断</strong> : null}
      </div>
      <pre>{JSON.stringify(payload, null, 2)}</pre>
    </section>
  );
}
