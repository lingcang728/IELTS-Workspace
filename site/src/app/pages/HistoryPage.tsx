/**
 * 历史记录 — web port of the desktop `History` page. Lists every session
 * newest-first with real progress (answered/total), then routes: continue
 * unfinished work in the exam runtime, review submitted papers, archive
 * submitted ones out of the list, or delete after a confirm.
 */
import { useEffect, useState } from "react";
import type { Route } from "../nav";
import { navigate } from "../nav";
import { archiveSession, discardSession, listSessions } from "../api";
import { formatDate, moduleLabel, statusLabel } from "../lib/format";
import { Icon, ModuleIcon, PageHeading, SessionProgress } from "../components/ReviewShared";
import type { SessionSummary } from "../types";

type Filter = "all" | "active" | "submitted" | "interrupted";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "全部记录" },
  { value: "active", label: "进行中" },
  { value: "submitted", label: "已提交" },
  { value: "interrupted", label: "已中断" },
];

function matches(row: SessionSummary, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "submitted") return row.status === "submitted";
  if (filter === "interrupted") return row.status === "interrupted" || row.integrity === "interrupted";
  return row.status === "in_progress" || row.status === "created";
}

export default function HistoryPage({ route }: { route: Route }) {
  void route;
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    try {
      setSessions(await listSessions());
      setError(null);
    } catch (e) {
      setError(`历史记录读取失败：${String(e)}`);
    }
  }

  useEffect(() => { void reload(); }, []);

  async function remove(row: SessionSummary) {
    if (!window.confirm(`确定删除「${row.title || row.examId}」这条会话记录吗？此操作不可撤销。`)) return;
    try {
      await discardSession(row.id);
      await reload();
    } catch (e) {
      setError(`删除失败：${String(e)}`);
    }
  }

  async function archive(row: SessionSummary) {
    try {
      await archiveSession(row.id);
      await reload();
    } catch (e) {
      setError(`归档失败：${String(e)}`);
    }
  }

  const visible = (sessions ?? []).filter((row) => matches(row, filter));

  return <div className="history-page page-stack">
    <PageHeading
      title="历史记录"
      subtitle="查看已完成考试，或恢复安全保存的未完成会话"
      aside={<label className="select-field"><span className="sr-only">状态筛选</span>
        <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
          {FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select></label>} />

    {error && <p className="form-error">{error}</p>}

    {sessions === null && !error && <div className="workspace-card empty-state compact"><p className="meta">正在读取历史记录…</p></div>}

    {sessions !== null && <div className="history-list">
      {visible.map((s) => {
        const resumable = s.status === "in_progress" || s.status === "created" || s.status === "interrupted";
        return <article className="workspace-card history-row" key={s.id}>
          <ModuleIcon module={s.module} size={46} />
          <div className="history-info">
            <h3>{s.title || s.examId}</h3>
            <span>
              <b className={`mode-label ${s.mode}`}>{s.mode === "mock" ? "模考" : "练习"}</b>
              {moduleLabel(s.module)} · {statusLabel(s.status)} · {s.integrity === "clean" ? "完整" : "中断"}
            </span>
            <small>{formatDate(s.updatedAt)}</small>
            <SessionProgress session={s} />
          </div>
          <div className="history-actions">
            {resumable
              ? <button type="button" className="secondary-button" onClick={() => navigate("/app/exam", { exam: s.examId, session: s.id })}>继续</button>
              : <button type="button" className="secondary-button" onClick={() => navigate("/app/results", { session: s.id })}>看结果</button>}
            {s.status === "submitted" && <button type="button" className="link-button" onClick={() => void archive(s)}>归档</button>}
            <button type="button" className="link-button" onClick={() => void remove(s)}>删除</button>
          </div>
        </article>;
      })}
      {visible.length === 0 && <div className="workspace-card empty-state">
        <Icon name="history" size={42} />
        <h2>{filter === "all" ? "还没有记录" : "这个筛选下没有记录"}</h2>
        <p>从题库开始一次练习或模考，记录会自动出现在这里。</p>
        <div className="button-row"><button type="button" className="secondary-button" onClick={() => navigate("/app/library")}>去题库</button></div>
      </div>}
    </div>}
  </div>;
}
