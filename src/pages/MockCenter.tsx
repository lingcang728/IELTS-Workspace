import { useMemo, useState } from "react";
import { Icon } from "../components/Ui";
import { PageHeading } from "../components/Shell";
import { BookCatalog, RecentMockList, SessionRow } from "../components/ExamRows";
import { CatalogToolbar } from "../components/Catalog";
import { filterCatalog, groupCatalog } from "../lib/catalog";
import type { ExamSummary, SessionSummary } from "../lib/types";
import type { CatalogModule, View } from "../lib/view";

export function MockCenter({ exams, sessions, recovery, busy, onStart, onRetake, onContinue, onView }: { exams: ExamSummary[]; sessions: SessionSummary[]; recovery: SessionSummary[]; busy: boolean; onStart: (e: ExamSummary, mode: "mock" | "practice") => void; onRetake: (e: ExamSummary, mode: "mock" | "practice") => void; onContinue: (id: string) => void; onView: (v: View) => void }) {
  const [module, setModule] = useState<CatalogModule>("all");
  const [query, setQuery] = useState("");
  const groups = useMemo(() => filterCatalog(groupCatalog(exams), module, query), [exams, module, query]);
  const examCount = groups.reduce((n, group) => n + group.tests.reduce((m, test) => m + test.exams.length, 0), 0);
  const completed = sessions.filter((s) => s.mode === "mock" && s.status === "submitted");
  return <div className="mock-page page-stack"><PageHeading title="模考中心" subtitle="官方样题与全真模考，严格按真实考试流程，提升应试能力与时间管理" />
    <div className="mock-layout"><div className="mock-main">{recovery.length > 0 && <section className="workspace-card resume-card"><div><h2>继续未完成模考</h2></div>{recovery.slice(0, 1).map((s) => <SessionRow key={s.id} session={s} action="继续模考" onClick={() => onContinue(s.id)} />)}</section>}<section className="workspace-card catalog-card mock-catalog"><CatalogToolbar module={module} setModule={setModule} query={query} setQuery={setQuery} /><div className="catalog-heading"><h2>可用模考</h2><span>{examCount} 套</span></div>{groups.length === 0 ? <div className="empty-state compact"><Icon name="search" /><p>没有找到符合条件的模考。</p></div> : <BookCatalog groups={groups} mode="mock" busy={busy} audioAction="添加音频" startAction="开始模考" onStart={(e) => onStart(e, "mock")} onRetake={(e) => onRetake(e, "mock")} />}</section></div>
      <aside className="mock-aside"><section className="workspace-card recent-mock-card"><div className="card-heading"><h2>最近模考成绩</h2><button type="button" className="link-button" onClick={() => onView("history")}>查看全部 <Icon name="arrow" size={14} /></button></div><RecentMockList sessions={completed.slice(0, 2)} /></section></aside>
    </div></div>;
}
