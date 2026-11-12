/**
 * Trace 列表分页控件（M2-04 #19）：上一页 / 页码 / 下一页（票面：只做 OFFSET 翻页，
 * 不做总页数跳转——契约形状只给 page/page_size/total）。
 *
 * 总页数由 total 与 page_size 前端算（向上取整），页码窗口最多 5 个；
 * 边界按钮 disabled，不隐藏（避免布局跳动）。
 */

interface PagerProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}

/** 总页数（向上取整，至少 1 页）——列表页与分页控件共用一个口径。 */
export function totalPagesOf(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** 页码窗口：当前页居中，最多 5 个，两端收敛到合法范围。 */
export function pageWindow(page: number, totalPages: number): number[] {
  if (totalPages <= 0) return [];
  const width = Math.min(5, totalPages);
  let start = page - Math.floor(width / 2);
  start = Math.max(1, Math.min(start, totalPages - width + 1));
  return Array.from({ length: width }, (_, i) => start + i);
}

export default function TracePager({ page, pageSize, total, onPageChange }: PagerProps) {
  const totalPages = totalPagesOf(total, pageSize);
  const windowPages = pageWindow(page, totalPages);

  return (
    <nav className="pager" aria-label="Trace 列表分页">
      <button
        type="button"
        className="pager-btn"
        onClick={() => onPageChange(page - 1)}
        disabled={page <= 1}
      >
        上一页
      </button>
      {windowPages.map((p) => (
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
