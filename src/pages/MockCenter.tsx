import { useEffect, useMemo, useState } from "react";
import { Icon } from "../components/Ui";
import { PageHeading } from "../components/Shell";
import { ExamCatalogRow, RecentMockList, SessionRow } from "../components/ExamRows";
import { CatalogToolbar, Pagination } from "../components/Catalog";
import { sourceLabel } from "../lib/format";
import type { ExamSummary, SessionSummary } from "../lib/types";
import type { CatalogModule, View } from "../lib/view";

export function MockCenter({ exams, sessions, recovery, busy, onStart, onContinue, onView }: { exams: ExamSummary[]; sessions: SessionSummary[]; recovery: SessionSummary[]; busy: boolean; onStart: (e: ExamSummary, mode: "mock" | "practice") => void; onContinue: (id: string) => void; onView: (v: View) => void }) {
  const [module, setModule] = useState<CatalogModule>("all"); const [query, setQuery] = useState(""); const [page, setPage] = useState(0);
  const filtered = useMemo(() => exams.filter((e) => (module === "all" || e.module === module) && `${e.title} ${sourceLabel(e)}`.toLowerCase().includes(query.trim().toLowerCase())), [exams, module, query]);
  const pageSize = 6; const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize)); const visible = filtered.slice(page * pageSize, (page + 1) * pageSize); const completed = sessions.filter((s) => s.mode === "mock" && s.status === "submitted");
  useEffect(() => setPage(0), [module, query]);
  return <div className="mock-page page-stack"><PageHeading title="模考中心" subtitle="官方样题与全真模考，严格按真实考试流程，提升应试能力与时间管理" />
    <div className="mock-layout"><div className="mock-main">{recovery.length > 0 && <section className="workspace-card resume-card"><div><h2>继续未完成模考</h2></div>{recovery.slice(0, 1).map((s) => <SessionRow key={s.id} session={s} action="继续模考" onClick={() => onContinue(s.id)} />)}</section>}<section className="workspace-card catalog-card mock-catalog"><CatalogToolbar module={module} setModule={setModule} query={query} setQuery={setQuery} /><div className="catalog-heading"><h2>可用模考</h2><span>{filtered.length} 套</span></div><div className="catalog-list">{visible.map((e) => <ExamCatalogRow key={e.id} exam={e} mode="mock" action="开始模考" busy={busy} onClick={() => onStart(e, "mock")} />)}</div><Pagination page={page} pageCount={pageCount} setPage={setPage} /></section></div>
      <aside className="mock-aside"><section className="workspace-card recent-mock-card"><div className="card-heading"><h2>最近模考成绩</h2><button type="button" className="link-button" onClick={() => onView("history")}>查看全部 <Icon name="arrow" size={14} /></button></div><RecentMockList sessions={completed.slice(0, 2)} /></section></aside>
    </div></div>;
}
