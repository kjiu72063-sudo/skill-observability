/**
 * 路由表（M2-03 #18）：HashRouter 四路由——#2 决议 IA 四区块一一对应。
 *
 * 路由方案 HashRouter 的原因（决策留痕）：demo.py 的 StaticFiles(html=True)
 * 无 SPA fallback——GET /trace 直接 404（实测），而 demo.py 在本票禁改清单，
 * BrowserRouter 的「刷新后落在原区块」验收在 demo 路径下物理不可能达成；
 * /#/trace 形式刷新即落位、后端零改动。未知路由重定向回 /trace 兜底。
 */

import { Navigate, Route, Routes } from "react-router-dom";

import { AuditPage, RulesPage, StatsPage, TracePage } from "./placeholders";

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/trace" replace />} />
      <Route path="/trace" element={<TracePage />} />
      <Route path="/audit" element={<AuditPage />} />
      <Route path="/rules" element={<RulesPage />} />
      <Route path="/stats" element={<StatsPage />} />
      <Route path="*" element={<Navigate to="/trace" replace />} />
    </Routes>
  );
}
