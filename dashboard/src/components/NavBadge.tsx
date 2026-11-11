/**
 * 行数计数徽标（M2-03 #18）：侧边栏每项导航右侧的 rail-num。
 *
 * 三态：数字（真数据）/ 「—」占位（端点未就绪，规则徽标等 M2-09）/ 空（加载中，不闪 0）。
 * 徽标本身中性色（--ink4）；红/琥珀/灰三信号色徽标首次使用在 M2-04/M2-07（verdict 语义）。
 */

export default function NavBadge({ value }: { value: number | null | undefined }) {
  if (value === undefined) return null; // 加载中：空，不闪 0
  return <span className="rail-num">{value === null ? "—" : value}</span>;
}
