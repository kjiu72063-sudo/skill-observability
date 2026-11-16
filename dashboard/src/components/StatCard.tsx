import type { ReactNode } from "react";

export type StatCardStatus = "loading" | "error" | "empty" | "ready";

interface StatCardProps {
  id: string;
  title: string;
  description: string;
  status: StatCardStatus;
  value?: ReactNode;
  emptyValue?: ReactNode;
  errorMessage?: string;
  accent?: "default" | "alert";
}

export default function StatCard({
  id,
  title,
  description,
  status,
  value,
  emptyValue = "—",
  errorMessage = "统计读取失败",
  accent = "default",
}: StatCardProps) {
  const titleId = id + "-title";
  const stateValue =
    status === "loading" ? "加载中…" : status === "error" ? "—" : status === "empty" ? emptyValue : value ?? "—";

  return (
    <article
      className={"stat-card stat-card-" + status}
      data-accent={accent}
      data-status={status}
      data-testid={id}
      aria-labelledby={titleId}
    >
      <div className="stat-card-head">
        <h3 id={titleId}>{title}</h3>
        <span className="stat-card-index" aria-hidden="true">{id.replace("stat-card-", "").padStart(2, "0")}</span>
      </div>
      <div className="stat-card-value" role={status === "loading" ? "status" : undefined}>
        {stateValue}
      </div>
      <p className="stat-card-description">{status === "error" ? errorMessage : description}</p>
    </article>
  );
}
