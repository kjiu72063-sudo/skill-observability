/**
 * 壳页（M2-02 #17）：空布局 + 标题占位——布局挂载点，无导航无数据无任何业务 UI
 * （那是 M2-03 及以后的事）。四区块导航位、内容区均以注释占位，后续票往里填。
 */

export default function Shell() {
  return (
    <div className="shell">
      {/* M2-03：左侧边栏 4 项导航（Trace / 审计日志 / 规则管理 / 统计卡片）+ 行数计数徽标 */}
      <main className="shell-main">
        <header className="shell-head">
          <h1 className="shell-title">
            SIGIL<b>·</b>Agent Skill 合规可观测
          </h1>
          <p className="shell-sub">M2 看板 · 壳页（工程脚手架，无业务区块）</p>
        </header>
        {/* M2-03 起在此挂四区块内容 */}
      </main>
    </div>
  );
}
