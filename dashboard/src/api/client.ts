/**
 * API 客户端基座（M2-02 #17）：统一 baseURL=/api、错误形状、纳秒无损解析。
 *
 * - 响应一律先取原始文本再经 parseLossless 解析（见 losslessJson.ts），
 *   `*_unix_nano` 与超安全范围整数以字符串进组件树——全段地基，勿改回 json()。
 * - 错误形状按契约统一：非 2xx 时 FastAPI 返回 `{"detail": "..."}`，
 *   抛 ApiError（携带 status + detail），调用方只 catch 一种类型。
 * - 泛型 <T> 由各票按契约逐端点声明（本票不预定义任何端点类型）。
 */

import { parseLossless, type LosslessParsed } from "./losslessJson";

export const API_BASE = "/api";

export class ApiError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(`API ${status}: ${detail}`);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

/** 从错误响应体提取 detail；形状异常时回退为原始片段，绝不抛出。 */
function extractDetail(raw: string): string {
  try {
    const body = JSON.parse(raw) as { detail?: unknown };
    if (typeof body.detail === "string") return body.detail;
    if (body.detail != null) return JSON.stringify(body.detail);
  } catch {
    // 非 JSON 响应体（如代理错误页）——走回退
  }
  return raw.slice(0, 200) || "（空响应体）";
}

/** GET /api 下相对路径，返回无损解析后的 JSON。 */
export async function apiGet<T = LosslessParsed>(path: string, signal?: AbortSignal): Promise<T> {
  const resp = await fetch(`${API_BASE}${path}`, { signal });
  const text = await resp.text();
  if (!resp.ok) throw new ApiError(resp.status, extractDetail(text));
  return parseLossless(text) as T;
}
