import { apiGet } from "./client";

export interface TotalResponse {
  total: number;
}

export interface RuleHit {
  rule_id: string;
  rule_name: string;
  action: "block" | "audit";
  verdict_block_hits: number;
  verdict_audit_hits: number;
  hits: number;
}

export interface RuleStatsResponse {
  items: RuleHit[];
  total: number;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && Number.isFinite(value) && value >= 0;
}

function guardTotal(body: unknown, path: string): number {
  if (!body || typeof body !== "object" || !isCount((body as { total?: unknown }).total)) {
    throw new Error("统计 API 响应形状异常：" + path + " 缺少合法 total");
  }
  return (body as TotalResponse).total;
}

function isRuleHit(value: unknown): value is RuleHit {
  if (!value || typeof value !== "object") return false;
  const rule = value as Record<string, unknown>;
  return (
    typeof rule.rule_id === "string" &&
    typeof rule.rule_name === "string" &&
    (rule.action === "block" || rule.action === "audit") &&
    isCount(rule.verdict_block_hits) &&
    isCount(rule.verdict_audit_hits) &&
    isCount(rule.hits)
  );
}

function guardRuleStats(body: unknown): RuleStatsResponse {
  if (!body || typeof body !== "object") {
    throw new Error("统计 API 响应形状异常：by-rule 响应不是对象");
  }
  const response = body as { items?: unknown; total?: unknown };
  if (!Array.isArray(response.items) || !isCount(response.total) || !response.items.every(isRuleHit)) {
    throw new Error("统计 API 响应形状异常：by-rule 缺少合法 items/total");
  }
  return body as RuleStatsResponse;
}

async function fetchTotal(path: string, signal?: AbortSignal): Promise<number> {
  return guardTotal(await apiGet<TotalResponse>(path, signal), path);
}

export function fetchTraceTotal(signal?: AbortSignal): Promise<number> {
  return fetchTotal("/traces?page_size=1", signal);
}

export function fetchLiveTraceTotal(signal?: AbortSignal): Promise<number> {
  return fetchTotal("/traces?live=true&page_size=1", signal);
}

export function fetchAuditTotal(signal?: AbortSignal): Promise<number> {
  return fetchTotal("/audits?page_size=1", signal);
}

export function fetchBlockedAuditTotal(signal?: AbortSignal): Promise<number> {
  return fetchTotal("/audits?verdict=block&page_size=1", signal);
}

export function fetchObservedAuditTotal(signal?: AbortSignal): Promise<number> {
  return fetchTotal("/audits?action=audit&page_size=1", signal);
}

export async function fetchRuleStats(signal?: AbortSignal): Promise<RuleStatsResponse> {
  return guardRuleStats(await apiGet<RuleStatsResponse>("/audits/stats/by-rule?limit=1", signal));
}

export async function fetchTopRule(signal?: AbortSignal): Promise<RuleHit | null> {
  const response = await fetchRuleStats(signal);
  return response.items[0] ?? null;
}
