/**
 * 壳页（M2-03 #18）：HashRouter + 顶栏（品牌标题）+ 左侧边栏四项导航 + 路由出口。
 *
 * 布局对齐 #2 原型定案：topbar（58px）+ .shell 网格（172px 侧栏 + 内容区）。
 * 顶栏右侧系统健康点（绿=系统健康，非 verdict——CONTEXT.md 看板术语）随本票上壳；
 * 四区块内容 = <Outlet/>（M2-03 全是占位页）。
 */

import { HashRouter } from "react-router-dom";

import Sidebar from "../components/Sidebar";
import AppRoutes from "./routes";

export default function Shell() {
  return (
    <HashRouter>
      <div className="app">
        <header className="topbar">
          <div className="brand">
            <span className="logo">
              SIG<b>IL</b>
            </span>
            <span className="sub">AGENT SKILL 合规可观测平台</span>
          </div>
          <div className="top-right">
            <div className="sys">
              <span className="dot" aria-hidden="true" />
              <span>实时推送中</span>
            </div>
          </div>
        </header>
        <div className="shell">
          <Sidebar />
          <main className="shell-main">
            <AppRoutes />
          </main>
        </div>
      </div>
    </HashRouter>
  );
}
