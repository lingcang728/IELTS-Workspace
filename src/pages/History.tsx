import { Icon, ModuleIcon } from "../components/Ui";
import { PageHeading } from "../components/Shell";
import { formatDate, statusLabel } from "../lib/format";
import type { SessionSummary } from "../lib/types";

export function History({ sessions, onOpen }: { sessions: SessionSummary[]; onOpen: (id: string) => void }) {
  return <div className="history-page page-stack"><PageHeading title="历史记录" subtitle="查看已完成考试，或恢复安全保存的未完成会话" /><div className="history-list">{sessions.map((s) => <article className="workspace-card history-row" key={s.id}><ModuleIcon module={s.module} size={46} /><div className="history-info"><h3>{s.title || s.examId}</h3><span><b className={`mode-label ${s.mode}`}>{s.mode === "mock" ? "Mock" : "Practice"}</b>{s.module} · {statusLabel(s.status)} · {s.integrity === "clean" ? "完整" : "中断"}</span><small>{formatDate(s.updatedAt)}</small></div><button type="button" className="secondary-button" onClick={() => onOpen(s.id)}>{s.status === "submitted" ? "查看结果" : "继续"}</button></article>)}{sessions.length === 0 && <div className="workspace-card empty-state"><Icon name="history" size={42} /><h2>还没有记录</h2><p>从工作台开始一次练习或模考。</p></div>}</div></div>;
}
