import { Icon } from "../components/Ui";
import { PageHeading } from "../components/Shell";
import { ExamRow, ModuleCard, RecordTable, SessionRow } from "../components/ExamRows";
import { MiniTrend } from "../components/Charts";
import { daysUntil, rangeLabel } from "../lib/format";
import type { AnalyticsReport, Bootstrap, ExamSummary } from "../lib/types";
import type { View } from "../lib/view";

export function Workbench({ boot, analytics, busy, onStart, onView, rangeDays }: { boot: Bootstrap; analytics: AnalyticsReport | null; busy: boolean; onStart: (e: ExamSummary, mode: "mock" | "practice") => void; onView: (v: View) => void; rangeDays: number }) {
  const first = (module: ExamSummary["module"]) => boot.exams.find((e) => e.module === module);
  const recent = boot.sessions.filter((s) => s.status === "submitted").slice(0, 4);
  const avg = analytics?.overallAverage;
  const countdown = daysUntil(boot.profile?.examDate);
  return <div className="dashboard-page page-stack"><PageHeading title={<>欢迎回来！ <span className="wave-mark">👋</span></>} subtitle={<>在这里开始你的 <em>IELTS Academic</em> 练习与模考</>} aside={countdown == null
      ? <blockquote>Success is the sum of small efforts,<br />repeated day in and day out.<cite>— Robert Collier</cite></blockquote>
      : <div className="exam-countdown"><small>距考试还有</small><strong>{countdown > 0 ? countdown : 0}</strong><span>{countdown > 0 ? "天" : countdown === 0 ? "天 · 就是今天" : "天 · 考试日已过"}</span><b>{boot.profile?.examDate}</b></div>} />
    <div className="dashboard-grid top-grid"><section className="workspace-card quick-start"><div className="card-heading"><div><h2>快速开始</h2><p>选择题型，立即开始练习或模考</p></div></div><div className="module-grid">{(["reading", "listening", "writing"] as const).map((m) => { const ex = first(m); return <ModuleCard key={m} module={m} exam={ex} disabled={busy} onStart={() => ex && onStart(ex, "practice")} />; })}</div></section><section className="workspace-card recent-use"><div className="card-heading"><h2>官方样题 / 最近使用</h2><button type="button" className="link-button" onClick={() => onView("mock")}>查看全部 <Icon name="arrow" size={15} /></button></div>{boot.exams.slice(0, 1).map((e) => <ExamRow key={e.id} exam={e} action="开始模考" onClick={() => onStart(e, "mock")} />)}{boot.sessions[0] ? <SessionRow session={boot.sessions[0]} action="继续练习" onClick={() => onView("history")} /> : <p className="empty-inline">完成练习后，这里会保留最近进度。</p>}</section></div>
    <div className="dashboard-grid bottom-grid"><section className="workspace-card recent-records"><div className="card-heading"><h2>最近模考记录</h2><button type="button" className="link-button" onClick={() => onView("history")}>查看全部 <Icon name="arrow" size={15} /></button></div><RecordTable sessions={recent} /></section><section className="workspace-card analytics-overview"><div className="card-heading"><h2>分析概览</h2><button type="button" className="link-button" onClick={() => onView("analytics")}>{rangeLabel(rangeDays)} <Icon name="arrow" size={14} /></button></div><div className="analytics-summary"><div className="average-score"><span>平均估算 Band</span><strong className={avg == null ? "no-data" : undefined}>{avg == null ? "—" : avg.toFixed(1)}</strong><small>{avg == null ? "提交考试后显示真实数据" : "非官方估算，来自已提交的真实会话"}</small></div><MiniTrend points={analytics?.timeTrend ?? []} /></div></section></div>
  </div>;
}
