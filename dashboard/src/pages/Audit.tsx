/**
 * 审计日志区块（M2-07 #22）：表格 + 四段筛选（全部 / 拦截 / 放行 / 观察期）。
 *
 * 数据流：`[page, filter, reloadTick]` 驱动 REST 快照（`GET /api/audits`）。
 * - 筛选切换 = 改 filter + **页码重置到 1**（票面验收）：第 2 页的观察期结果
 *   可能是空的，停在原页会看起来像「没有观察期命中」。
 * - 口径唯一出自服务端：段 → 参数映射在 `auditQuery`，本页不做行级过滤，
 *   也不自算总数（total 一律用响应里的值）。
 * - 竞态：每次 effect 自建 AbortController，cleanup 即 abort（与原 Trace 列表同款）。
 *
 * 本票不做：行展开 payload / → trace 跳转（归 M2-08）、实时流（保持 REST 快照）。
 */

import { useEffect, useState } from "react";

import {
  AUDIT_PAGE_SIZE,
  auditQuery,
  fetchAudits,
  type AuditFilter,
  type AuditListItem,
} from "../api/audits";
import { ApiError } from "../api/client";
import AuditFilters from "../components/AuditFilters";
import AuditPager from "../components/AuditPager";
import AuditTable, { AuditTableEmpty } from "../components/AuditTable";
import { totalPagesOf } from "../components/TracePager";
import "./Audit.css";

type ListState =
  | { kind: "loading" }
  | { kind: "error"; message: string; page: number }
  | { kind: "ready"; items: AuditListItem[]; page: number; pageSize: number; total: number };

/** 当前筛选的查询串（展示用：让「口径出自服务端」在 UI 上可见，也便于 QA 对照 curl）。 */
function filterQueryLabel(filter: AuditFilter): string {
  const q = new URLSearchParams(auditQuery(filter)).toString();
  return q ? `?${q}` : "";
}

export default function AuditPage() {
  const [filter, setFilter] = useState<AuditFilter>("all");
  const [page, setPage] = useState(1);
  // 重试同一页：page/filter 都不变也要重新触发 effect
  const [reloadTick, setReloadTick] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [state, setState] = useState<ListState>({ kind: "loading" });

  useEffect(() => {
    const ctrl = new AbortController();
    let alive = true;
    setState((prev) => (prev.kind === "ready" ? prev : { kind: "loading" }));
    fetchAudits(page, filter, AUDIT_PAGE_SIZE, ctrl.signal)
      .then((body) => {
        if (!alive) return;
        // DB 重置/总数缩水：请求页已越界，回落到最后一页（不渲染「第 2/1 页」）。
        // 可达路径：demo.py 每次启动 unlink 库 → 停在第 2 页重启后点「重试」。
        // 兜底与 Trace 列表同款（Trace.tsx 同位置同写法，评审 P2-1）。
        const totalPages = totalPagesOf(body.total, body.page_size);
        if (body.page > totalPages) {
          setPage(totalPages);
          return;
        }
        setState({
          kind: "ready",
          items: body.items,
          page: body.page,
          pageSize: body.page_size,
          total: body.total,
        });
      })
      .catch((err: unknown) => {
        if (!alive) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        const message =
          err instanceof ApiError
            ? `取数失败（HTTP ${err.status}）：${err.detail}`
            : err instanceof Error
              ? err.message
              : "取数失败";
        setState({ kind: "error", message, page });
      });
    return () => {
      alive = false;
      ctrl.abort();
    };
  }, [page, filter, reloadTick]);

  const handleFilterChange = (next: AuditFilter) => {
    if (next === filter) return;
    setFilter(next);
    setPage(1); // 票面验收：筛选切换后页码重置到 1
    setSelectedId(null); // 换了筛选集合，旧选中行不在眼前
  };

  const handlePageChange = (next: number) => {
    if (next === page || next < 1) return;
    if (state.kind === "ready" && next > Math.ceil(state.total / state.pageSize)) return;
    setSelectedId(null);
    setPage(next);
  };

  const retry = () => {
    if (state.kind === "error") setPage(state.page);
    setReloadTick((t) => t + 1);
  };

  return (
    <section>
      <div className="view-head">
        <div>
          <h2 className="page-title">审计日志</h2>
          <div className="view-desc">
            每次 Skill 调用恰一行 · 无论放行与否
            <span className="ep-chip">
              <i>GET</i> /api/audits{filterQueryLabel(filter)}
            </span>
          </div>
        </div>
        <AuditFilters value={filter} onChange={handleFilterChange} />
      </div>

      <div className="card audit-card">
        <AuditBody
          state={state}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onRetry={retry}
        />
        {state.kind === "ready" && state.total > 0 ? (
          <AuditPager
            page={state.page}
            pageSize={state.pageSize}
            total={state.total}
            onPageChange={handlePageChange}
          />
        ) : null}
      </div>
    </section>
  );
}

function AuditBody({
  state,
  selectedId,
  onSelect,
  onRetry,
}: {
  state: ListState;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  onRetry: () => void;
}) {
  if (state.kind === "loading") {
    return (
      <div className="audit-state" role="status" aria-live="polite">
        加载中…
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="audit-state audit-error">
        <div role="alert">{state.message}</div>
        <button type="button" className="pager-btn retry-btn" onClick={onRetry}>
          重试
        </button>
      </div>
    );
  }
  if (state.items.length === 0) {
    return <AuditTableEmpty title="无匹配审计记录" hint="调整筛选条件，或跑 python demo.py 产生数据" />;
  }
  return <AuditTable items={state.items} selectedId={selectedId} onSelect={onSelect} />;
}
