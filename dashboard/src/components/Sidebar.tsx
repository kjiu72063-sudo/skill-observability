/**
 * 左侧边栏（M2-03 #18）：四项导航 + 行数计数徽标——#2 决议 IA 第 1 条。
 *
 * 结构对齐原型 .rail（prototype/kanban-infoarch 分支）：按钮 = 图标 + 标签 + rail-num；
 * 选中态由 NavLink aria-current 驱动（青 accent 渐变底 + 左侧青条，见 Shell.css）。
 * 徽标语义（#2 定案）：Trace/审计接真数据；规则恒「—」占位（/api/rules 等 M2-09）、
 * 统计无徽标（统计是 8 卡页面，无行数语义）。
 *
 * 实时（M2-06 #21）：本组件是 SSE 连接的常驻宿主——始终挂载，故离开 Trace 页
 * 徽标仍随事件增长。事件驱动、**不轮询**：每收到一条事件起 200ms 防抖，结束后
 * 重取两枚 total（一次 run 十余条事件只触发一次重取）。
 */

import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";

import NavBadge from "./NavBadge";
import { fetchAuditTotal, fetchTraceTotal } from "../api/client";
import { useDebouncedStreamTick } from "../lib/traceStore";

/** 徽标重取的防抖窗口（票面建议值）：一次场景 run 的事件洪峰合成一次重取。 */
export const BADGE_DEBOUNCE_MS = 200;

const icon = (
  paths: string,
  circles?: ReadonlyArray<{ cx: number; cy: number; r: number }>
): React.ReactElement => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    {paths.split("|").map((d) => (
      <path key={d} d={d} strokeLinecap="round" strokeLinejoin="round" />
    ))}
    {(circles ?? []).map((c) => (
      <circle key={`${c.cx}-${c.cy}-${c.r}`} cx={c.cx} cy={c.cy} r={c.r} />
    ))}
  </svg>
);

/* 图标与原型逐字一致（原型分支 kanban-infoarch-wireframe.html 379–382 行；
 * rules = 4 辐条 path + 中心圆 <circle cx=12 cy=12 r=3.4>，HITL 确认形态不可缺元素）。
 * badge: "placeholder"=恒「—」（规则，等 M2-09）；省略 = 无徽标（统计）。 */
const ITEMS: ReadonlyArray<{
  to: string;
  label: string;
  paths: string;
  circles?: ReadonlyArray<{ cx: number; cy: number; r: number }>;
  badge?: "placeholder";
}> = [
  { to: "/trace", label: "Trace", paths: "M8 6h13M8 12h13M8 18h13|M3 6h.01|M3 12h.01|M3 18h.01" },
  {
    to: "/audit",
    label: "审计日志",
    paths: "M12 9v4m0 4h.01|M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
  },
  {
    to: "/rules",
    label: "规则管理",
    paths: "M12 3v3m0 12v3|M3 12h3m12 0h3|M5.6 5.6l2.2 2.2m8.4 8.4 2.2 2.2m0-12.8-2.2 2.2|M7.8 16.2l-2.2 2.2",
    circles: [{ cx: 12, cy: 12, r: 3.4 }],
    badge: "placeholder",
  },
  { to: "/stats", label: "统计卡片", paths: "M3 3v18h18|M7 15l4-5 3.5 3L19 7" },
];

/** 徽标三态值：number=真数据 / null=占位「—」 / undefined=加载中或无徽标。 */
type BadgeValue = number | null | undefined;

/**
 * 徽标取数：挂载取一次 + 每条 SSE 事件后 200ms 防抖重取（tick 由状态层给）。
 * 两枚独立成败，一枚 500 不拖垮另一枚。
 */
function useNavTotals(): { traces: BadgeValue; audits: BadgeValue } {
  const [totals, setTotals] = useState<{ traces: BadgeValue; audits: BadgeValue }>({
    traces: undefined,
    audits: undefined,
  });
  const tick = useDebouncedStreamTick(BADGE_DEBOUNCE_MS);

  useEffect(() => {
    let alive = true;
    const set = (key: "traces" | "audits") => (v: number | null) => {
      if (alive) setTotals((prev) => ({ ...prev, [key]: v }));
    };
    fetchTraceTotal().then(set("traces")).catch(() => set("traces")(null));
    fetchAuditTotal().then(set("audits")).catch(() => set("audits")(null));
    return () => {
      alive = false;
    };
  }, [tick]);

  return totals;
}

export default function Sidebar() {
  const totals = useNavTotals();

  return (
    <nav className="rail" aria-label="看板导航">
      <div className="rail-cap">看板</div>
      {ITEMS.map((item) => {
        // Trace/审计 = 真数据徽标；规则 = 「—」占位（badge=null）；统计 = 无徽标（undefined）
        const badge: BadgeValue =
          item.badge === "placeholder"
            ? null
            : item.to === "/trace"
              ? totals.traces
              : item.to === "/audit"
                ? totals.audits
                : undefined;
        return (
          <NavLink key={item.to} to={item.to} className="rail-btn">
            {icon(item.paths, item.circles)}
            <span className="lbl">{item.label}</span>
            {badge === undefined ? null : <NavBadge value={badge} />}
          </NavLink>
        );
      })}
      <div className="rail-spacer" />
      <div className="rail-cap">M1 · 演示数据</div>
    </nav>
  );
}
