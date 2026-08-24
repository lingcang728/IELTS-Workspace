import type { ReactNode } from "react";
import { BrandMark, Icon, type IconName, WindowControls } from "./Ui";
import type { View } from "../lib/view";

/** The window is `decorations: false`, so the app draws its own title bar. */
export function DesktopTitlebar() {
  return <header className="window-bar" data-tauri-drag-region>
    <div className="window-brand" data-tauri-drag-region><BrandMark size={18} className="titlebar-mark" /><span>IELTS Workspace</span></div>
    <WindowControls />
  </header>;
}

export function Sidebar({ view, setView }: { view: View; setView: (v: View) => void }) {
  const primary: { view: View; icon: IconName; label: string }[] = [
    { view: "home", icon: "grid", label: "工作台" },
    { view: "practice", icon: "pen", label: "练习" },
    { view: "mock", icon: "clock", label: "模考" },
    { view: "analytics", icon: "chart", label: "分析报告" },
  ];
  const nav = (item: { view: View; icon: IconName; label: string }) => <button key={item.view} type="button" className={view === item.view ? "selected" : ""} onClick={() => setView(item.view)}><Icon name={item.icon} size={21} /><span>{item.label}</span></button>;
  return <aside className="sidebar">
    <div className="sidebar-brand"><BrandMark size={56} className="sidebar-mark" /><div><strong>IELTS</strong><span>Workspace</span></div></div>
    <nav className="side-nav" aria-label="主导航">{primary.map(nav)}</nav>
    <div className="sidebar-spacer" />
    <nav className="side-nav" aria-label="辅助导航">
      {nav({ view: "history", icon: "history", label: "历史记录" })}
      {nav({ view: "settings", icon: "settings", label: "设置" })}
    </nav>
  </aside>;
}

export function PageHeading({ eyebrow, title, subtitle, aside }: { eyebrow?: string; title: ReactNode; subtitle?: ReactNode; aside?: ReactNode }) {
  return <div className="page-heading"><div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>{aside}</div>;
}
