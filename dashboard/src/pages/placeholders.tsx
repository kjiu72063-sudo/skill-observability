/**
 * 两路由占位页（M2-03 #18；M2-04 #19 起 Trace 换真页、M2-07 #22 起审计换真页，
 * 本文件只余两页）。
 *
 * 页号映射：规则 = M2-09/M2-10（#24/#25）、统计 = M2-11/M2-12（#26/#27）。
 * 已由真页接管：Trace = ./Trace.tsx、审计 = ./Audit.tsx。
 */

interface PlaceholderProps {
  title: string;
  ticket: string;
}

export function PlaceholderPage({ title, ticket }: PlaceholderProps) {
  return (
    <section className="page">
      <h2 className="page-title">{title}</h2>
      <p className="page-hint">{ticket} 建设中——本票（M2-03）只立骨架，内容归后续票。</p>
    </section>
  );
}

export function RulesPage() {
  return <PlaceholderPage title="规则管理" ticket="M2-09/M2-10" />;
}

export function StatsPage() {
  return <PlaceholderPage title="统计卡片" ticket="M2-11/M2-12" />;
}
