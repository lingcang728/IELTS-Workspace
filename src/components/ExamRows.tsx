import { Icon, ModuleIcon } from "./Ui";
import { durationLabel, formatDate, moduleLabel, sourceLabel, statusLabel } from "../lib/format";
import type { ExamSummary, SessionSummary } from "../lib/types";

export function ModuleCard({ module, exam, onStart, disabled }: { module: "reading" | "listening" | "writing"; exam?: ExamSummary; onStart: () => void; disabled?: boolean }) {
  const meta = { reading: ["Reading", "学术类阅读", "60 分钟 · 3 篇文章 · 40 题"], listening: ["Listening", "学术类听力", "约 30 分钟 · 4 部分 · 40 题"], writing: ["Writing", "学术类写作", "60 分钟 · Task 1 & Task 2"] }[module];
  return <article className={`module-card ${module}`}><div className="module-card-main"><span className="module-icon-shell"><ModuleIcon module={module} size={56} /></span><div><h3>{meta[0]}</h3><span>{meta[1]}</span></div></div><small>{meta[2]}</small><button type="button" disabled={disabled || !exam} onClick={onStart}>开始练习</button></article>;
}

export function ExamRow({ exam, action, onClick }: { exam: ExamSummary; action: string; onClick: () => void }) {
  return <article className="exam-row"><ModuleIcon module={exam.module} size={44} /><div className="exam-row-copy"><span className="tag">{sourceLabel(exam)}</span><h3>{exam.title}</h3><p>{moduleLabel(exam.module)} · {exam.questionCount} 题</p></div><button type="button" className="secondary-button" onClick={onClick}>{action}</button></article>;
}

export function ExamCatalogRow({ exam, mode, action, busy, onClick }: { exam: ExamSummary; mode: "mock" | "practice"; action: string; busy: boolean; onClick: () => void }) {
  return <article className={`catalog-row ${exam.module}`}><ModuleIcon module={exam.module} size={42} /><div className="catalog-title"><h3>{exam.title}</h3><small>{sourceLabel(exam)}</small></div><span><small>模块</small>{moduleLabel(exam.module)}</span><span><small>时长</small>{durationLabel(exam)}</span><span><small>题量</small>{exam.questionCount || "—"} {exam.module === "writing" ? "任务" : "题"}</span><button type="button" className={mode === "mock" ? "strict-button" : "module-button"} disabled={busy} onClick={onClick}>{action}</button></article>;
}

export function SessionRow({ session, action, onClick }: { session: SessionSummary; action: string; onClick: () => void }) {
  return <article className="exam-row session-row"><span className="session-icon"><Icon name={session.status === "submitted" ? "check" : "clock"} size={22} /></span><div className="exam-row-copy"><h3>{session.title || session.examId}</h3><p>{session.mode === "mock" ? "模考" : "练习"} · {formatDate(session.updatedAt)}</p></div><button type="button" className="secondary-button" onClick={onClick}>{action}</button></article>;
}

export function RecordTable({ sessions }: { sessions: SessionSummary[] }) {
  if (!sessions.length) return <p className="empty-inline">完成一次模考后，记录会显示在这里。</p>;
  return <div className="record-table"><div className="record-head"><span>模考名称</span><span>完成时间</span><span>模块</span><span>状态</span></div>{sessions.map((s) => <div className="record-line" key={s.id}><strong>{s.title || s.examId}</strong><span>{formatDate(s.updatedAt)}</span><span>{moduleLabel(s.module)}</span><b>{statusLabel(s.status)}</b></div>)}</div>;
}

export function RecentMockList({ sessions }: { sessions: SessionSummary[] }) {
  if (!sessions.length) return <p className="empty-inline">完成一次模考后，成绩会显示在这里。</p>;
  return <div className="recent-mock-list">{sessions.map((session) => <article key={session.id}><ModuleIcon module={session.module} size={42} /><span><strong>{session.title || session.examId}</strong><small>完成时间：{formatDate(session.updatedAt)}</small></span><b>{statusLabel(session.status)}</b></article>)}</div>;
}
