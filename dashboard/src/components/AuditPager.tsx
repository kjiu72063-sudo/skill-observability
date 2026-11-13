/**
 * 审计分页控件（M2-07 #22）：形状与 TracePager 一致（OFFSET 翻页），
 * 总页数/页码窗口口径直接复用 TracePager 的两个纯函数（不复制一份口径）。
 *
 * 独立组件而非复用 TracePager：后者的 aria-label 与文案写死「Trace 列表」，
 * 改它就是越白名单改 Trace 区块组件。
 */

import { pageWindow, totalPagesOf } from "./TracePager";

export default function AuditPager({
  page,
  pageSize,
  total,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  const totalPages = totalPagesOf(total, pageSize);
  return (
    <nav className="pager" aria-label="审计列表分页">
      <button
        type="button"
        className="pager-btn"
        onClick={() => onPageChange(page - 1)}
        disabled={page <= 1}
      >
        上一页
      </button>
      {pageWindow(page, totalPages).map((p) => (
        <button
          key={p}
          type="button"
          className={`pager-num${p === page ? " on" : ""}`}
          aria-current={p === page ? "page" : undefined}
          onClick={() => onPageChange(p)}
        >
          {p}
        </button>
      ))}
      <button
        type="button"
        className="pager-btn"
        onClick={() => onPageChange(page + 1)}
        disabled={page >= totalPages}
      >
        下一页
      </button>
      <span className="pager-total">
        共 {total} 条 · 第 {page}/{totalPages} 页
      </span>
    </nav>
  );
}
