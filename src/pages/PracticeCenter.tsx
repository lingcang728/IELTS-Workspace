import { useEffect, useMemo, useState } from "react";
import { Icon } from "../components/Ui";
import { PageHeading } from "../components/Shell";
import { ExamCatalogRow, SessionRow } from "../components/ExamRows";
import { CatalogToolbar, Pagination } from "../components/Catalog";
import { WeeklyStat } from "../components/Charts";
import { completion, formatDay, isFinished, sourceLabel, startOfWeek } from "../lib/format";
import { listeningReady } from "../lib/audio";
import type { ExamSummary, SessionSummary } from "../lib/types";
import type { CatalogModule, View } from "../lib/view";

export function PracticeCenter({ exams, sessions, busy, onStart, onContinue, onView }: { exams: ExamSummary[]; sessions: SessionSummary[]; busy: boolean; onStart: (e: ExamSummary, mode: "mock" | "practice") => void; onContinue: (id: string) => void; onView: (v: View) => void }) {
  const [module, setModule] = useState<CatalogModule>("all"); const [query, setQuery] = useState(""); const [page, setPage] = useState(0);
  const filtered = useMemo(() => exams.filter((e) => (module === "all" || e.module === module) && `${e.title} ${sourceLabel(e)}`.toLowerCase().includes(query.trim().toLowerCase())), [exams, module, query]);
  const pageSize = 6; const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize)); const visible = filtered.slice(page * pageSize, (page + 1) * pageSize);
  const practiceSessions = sessions.filter((s) => s.mode === "practice"); const unfinished = practiceSessions.find((s) => s.status !== "submitted");
  // 本周 = 本地时区的周一 00:00 起。之前这一块统计的是全部历史会话。
  const weekStart = useMemo(() => startOfWeek(new Date()), []);
  const weekly = practiceSessions.filter((s) => Date.parse(s.startedAt) >= weekStart);
  // "Submitted" is not "finished": see `isFinished`. Counting submissions here
  // reported four completed papers in a week where most had been walked out of.
  const weeklyDone = weekly.filter(isFinished).length;
  const weeklyPartial = weekly.filter((s) => s.status === "submitted" && !isFinished(s)).length;
  const weeklyOpen = weekly.filter((s) => s.status !== "submitted").length;
  const ratios = weekly.map(completion).filter((r): r is number => r !== null);
  const averageDone = ratios.length
    ? Math.round((ratios.reduce((sum, r) => sum + r, 0) / ratios.length) * 100)
    : undefined;
  useEffect(() => setPage(0), [module, query]);
  return <div className="practice-page page-stack"><PageHeading title="练习中心" subtitle="自由选择模块与题目，按自己的节奏暂停、重听和复盘" />
    <div className="practice-features"><div><Icon name="target" /><span><strong>自由选题</strong><small>按模块和关键词快速定位</small></span></div><div><Icon name="pause" /><span><strong>可暂停重听</strong><small>练习模式不会强制交卷</small></span></div><div><Icon name="eye" /><span><strong>练后看解析</strong><small>提交后逐题核对答案</small></span></div></div>
    <div className="practice-layout"><section className="workspace-card catalog-card"><CatalogToolbar module={module} setModule={setModule} query={query} setQuery={setQuery} /><div className="catalog-heading"><h2>可用练习</h2><span>{filtered.length} 套</span></div><div className="catalog-list">{visible.map((e) => <ExamCatalogRow key={e.id} exam={e} mode="practice" action={e.module === "listening" && !listeningReady(e.audioStatus) ? "添加音频" : "开始练习"} busy={busy} onClick={() => onStart(e, "practice")} />)}{visible.length === 0 && <div className="empty-state compact"><Icon name="search" /><p>没有找到符合条件的练习。</p></div>}</div><Pagination page={page} pageCount={pageCount} setPage={setPage} /></section>
      <aside className="practice-aside"><section className="workspace-card continue-card"><div className="card-heading"><h2>继续上次练习</h2><button type="button" className="link-button" onClick={() => onView("history")}>查看全部 <Icon name="arrow" size={14} /></button></div>{unfinished ? <><SessionRow session={unfinished} action="继续练习" onClick={() => onContinue(unfinished.id)} /><small>进度会随作答自动保存</small></> : <p className="empty-inline">当前没有未完成练习。</p>}</section><section className="workspace-card weekly-card"><div className="card-heading"><h2>本周练习</h2><span className="meta">本机记录 · {formatDay(new Date(weekStart))} 起</span></div><WeeklyStat icon="clock" label="练习会话" value={`${weekly.length} 次`} /><WeeklyStat icon="check" label="完整做完" value={`${weeklyDone} 套`} ratio={averageDone} hint={weekly.length ? `本周平均做了 ${averageDone ?? 0}% 的题` : undefined} /><WeeklyStat icon="pause" label="做了一半就交" value={`${weeklyPartial} 套`} hint={weeklyPartial ? "这些没算进「完整做完」" : undefined} /><WeeklyStat icon="rotate" label="可恢复" value={`${weeklyOpen} 套`} /><small className="weekly-total">全部历史：{practiceSessions.length} 次练习</small></section></aside>
    </div></div>;
}
