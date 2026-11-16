import { useEffect, useState } from "react";

import { fetchRules } from "../api/rules";
import {
  fetchAuditTotal,
  fetchBlockedAuditTotal,
  fetchLiveTraceTotal,
  fetchObservedAuditTotal,
  fetchTopRule,
  fetchTraceTotal,
  type RuleHit,
} from "../api/stats";
import StatCard, { type StatCardStatus } from "../components/StatCard";
import { formatInterceptionRate } from "../lib/interceptionRate";
import "./Stats.css";

type Metric<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; value: T };

type Metrics = {
  traceTotal: Metric<number>;
  liveTraceTotal: Metric<number>;
  auditTotal: Metric<number>;
  blockedAuditTotal: Metric<number>;
  observedAuditTotal: Metric<number>;
  topRule: Metric<RuleHit | null>;
  enabledRuleTotal: Metric<number>;
};

const initialMetrics: Metrics = {
  traceTotal: { status: "loading" },
  liveTraceTotal: { status: "loading" },
  auditTotal: { status: "loading" },
  blockedAuditTotal: { status: "loading" },
  observedAuditTotal: { status: "loading" },
  topRule: { status: "loading" },
  enabledRuleTotal: { status: "loading" },
};

const metricKeys = [
  "traceTotal",
  "liveTraceTotal",
  "auditTotal",
  "blockedAuditTotal",
  "observedAuditTotal",
  "topRule",
  "enabledRuleTotal",
] as const;

type MetricKey = (typeof metricKeys)[number];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "统计读取失败";
}

function cardStatus<T>(metric: Metric<T>): StatCardStatus {
  return metric.status;
}

function metricError<T>(metric: Metric<T>): string | undefined {
  return metric.status === "error" ? metric.message : undefined;
}

export default function StatsPage() {
  const [metrics, setMetrics] = useState<Metrics>(initialMetrics);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setMetrics(initialMetrics);

    const loaders: Record<MetricKey, (signal: AbortSignal) => Promise<number | RuleHit | null>> = {
      traceTotal: fetchTraceTotal,
      liveTraceTotal: fetchLiveTraceTotal,
      auditTotal: fetchAuditTotal,
      blockedAuditTotal: fetchBlockedAuditTotal,
      observedAuditTotal: fetchObservedAuditTotal,
      topRule: fetchTopRule,
      enabledRuleTotal: (signal) => fetchRules(signal).then((rules) => rules.filter((rule) => rule.enabled).length),
    };

    void Promise.allSettled(metricKeys.map((key) => loaders[key](controller.signal))).then((results) => {
      if (!active) return;
      setMetrics((current) => {
        const next = { ...current };
        results.forEach((result, index) => {
          const key = metricKeys[index];
          if (!key) return;
          next[key] = result.status === "fulfilled"
            ? { status: "ready", value: result.value as never }
            : { status: "error", message: errorMessage(result.reason) };
        });
        return next;
      });
    });

    return () => {
      active = false;
      controller.abort();
    };
  }, [refreshTick]);

  const rateMetric: Metric<string> =
    metrics.auditTotal.status === "loading" || metrics.blockedAuditTotal.status === "loading"
      ? { status: "loading" }
      : metrics.auditTotal.status === "error"
        ? { status: "error", message: metrics.auditTotal.message }
        : metrics.blockedAuditTotal.status === "error"
          ? { status: "error", message: metrics.blockedAuditTotal.message }
          : {
              status: "ready",
              value: formatInterceptionRate(metrics.blockedAuditTotal.value, metrics.auditTotal.value),
            };

  const topRuleValue = metrics.topRule.status === "ready" ? metrics.topRule.value : null;

  return (
    <section className="stats-page">
      <div className="stats-header">
        <div>
          <p className="eyebrow">POLICY ENGINE / M2-12</p>
          <h1>统计卡片</h1>
          <p className="stats-subtitle">REST 快照 · 手动刷新读取 · DB 全量口径</p>
        </div>
        <button className="button button-ghost" type="button" onClick={() => setRefreshTick((tick) => tick + 1)}>
          ↻ 刷新统计
        </button>
      </div>

      <section className="stats-group" aria-labelledby="stats-group-chain">
        <div className="stats-group-heading">
          <h2 id="stats-group-chain">01 调用链</h2>
          <span>Trace 聚合</span>
        </div>
        <div className="stats-grid stats-grid-two">
          <StatCard id="stat-card-1" title="Trace 总数" description="root span 行数（含进行中）" status={cardStatus(metrics.traceTotal)} value={metrics.traceTotal.status === "ready" ? metrics.traceTotal.value : undefined} errorMessage={metricError(metrics.traceTotal)} />
          <StatCard id="stat-card-2" title="进行中 Trace" description="root end_time_unix_nano IS NULL" status={cardStatus(metrics.liveTraceTotal)} value={metrics.liveTraceTotal.status === "ready" ? metrics.liveTraceTotal.value : undefined} errorMessage={metricError(metrics.liveTraceTotal)} />
        </div>
      </section>

      <section className="stats-group" aria-labelledby="stats-group-interception">
        <div className="stats-group-heading">
          <h2 id="stats-group-interception">02 拦截</h2>
          <span>Audit 行聚合</span>
        </div>
        <div className="stats-grid">
          <StatCard id="stat-card-3" title="Skill 调用总数" description="每次 Skill 调用一行，无论 verdict" status={cardStatus(metrics.auditTotal)} value={metrics.auditTotal.status === "ready" ? metrics.auditTotal.value : undefined} errorMessage={metricError(metrics.auditTotal)} />
          <StatCard id="stat-card-4" title="拦截次数" description="verdict=block" status={cardStatus(metrics.blockedAuditTotal)} value={metrics.blockedAuditTotal.status === "ready" ? metrics.blockedAuditTotal.value : undefined} errorMessage={metricError(metrics.blockedAuditTotal)} />
          <StatCard id="stat-card-5" title="观察期命中" description="服务端 action=audit 权威语义" status={cardStatus(metrics.observedAuditTotal)} value={metrics.observedAuditTotal.status === "ready" ? metrics.observedAuditTotal.value : undefined} errorMessage={metricError(metrics.observedAuditTotal)} />
          <StatCard id="stat-card-6" title="拦截率" description="卡 4 ÷ 卡 3；分母为全部 Skill 调用" status={rateMetric.status} value={rateMetric.status === "ready" ? rateMetric.value : undefined} errorMessage={metricError(rateMetric)} accent="alert" />
          <StatCard id="stat-card-7" title="Top 命中规则" description="by-rule hits DESC，rule_id ASC 首项" status={metrics.topRule.status === "ready" && topRuleValue === null ? "empty" : cardStatus(metrics.topRule)} value={topRuleValue ? <><strong>{topRuleValue.rule_name}</strong><span className="stat-card-detail">{topRuleValue.hits} hits</span></> : undefined} emptyValue="暂无命中" errorMessage={metricError(metrics.topRule)} />
        </div>
      </section>

      <section className="stats-group" aria-labelledby="stats-group-rules">
        <div className="stats-group-heading">
          <h2 id="stats-group-rules">03 规则</h2>
          <span>Rule 列表聚合</span>
        </div>
        <div className="stats-grid stats-grid-one">
          <StatCard id="stat-card-8" title="启用中规则" description="/api/rules items 中 enabled=true 的客户端 count" status={cardStatus(metrics.enabledRuleTotal)} value={metrics.enabledRuleTotal.status === "ready" ? metrics.enabledRuleTotal.value : undefined} errorMessage={metricError(metrics.enabledRuleTotal)} />
        </div>
      </section>
    </section>
  );
}
