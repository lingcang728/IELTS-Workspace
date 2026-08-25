import { useMemo, useState } from "react";
import { Icon } from "../components/Ui";
import { PageHeading } from "../components/Shell";
import { sourceLabel } from "../lib/format";
import { listeningReady } from "../lib/audio";
import type { ExamSummary } from "../lib/types";

export function AudioCenter({
  exams,
  onAdd,
  onOpenGuide,
  onRemove,
}: {
  exams: ExamSummary[];
  onAdd: (examId?: string) => void;
  onOpenGuide: () => void;
  onRemove: (examId: string) => void;
}) {
  const listening = useMemo(
    () => exams.filter((e) => e.module === "listening"),
    [exams],
  );
  const bound = listening.filter((e) => listeningReady(e.audioStatus)).length;
  const [query, setQuery] = useState("");
  const visible = listening.filter((e) => `${e.title} ${sourceLabel(e)}`.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <div className="page-stack audio-page">
      <PageHeading
        title="听力资源"
        subtitle="题库已内置。Listening 音频由你在本机添加，应用不会联网下载。"
        aside={<div className="button-row">
          <button type="button" className="secondary-button" onClick={onOpenGuide}>打开下载指南</button>
          <button type="button" className="primary-button" onClick={() => onAdd()}>添加音频</button>
        </div>}
      />
      <section className="workspace-card">
        <p className="meta">已绑定 {bound} / {listening.length} 套 · 支持整轨、四个 Part、文件夹和每册 ZIP。C21 没有 Listening。</p>
        <label className="catalog-search audio-search"><Icon name="search" size={16} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索册次或 Test" /></label>
      </section>
      <section className="workspace-card catalog-card">
        <div className="catalog-list">
          {visible.map((exam) => {
            const ready = listeningReady(exam.audioStatus);
            return (
              <article key={exam.id} className={`catalog-row listening ${ready ? "" : "audio-missing"}`}>
                <span className={`audio-dot ${ready ? "ready" : "missing"}`} />
                <div className="catalog-title">
                  <h3>{exam.title}</h3>
                  <small>{sourceLabel(exam)}</small>
                </div>
                <span><small>状态</small>{ready ? "已就绪" : exam.audioStatus === "needsReview" ? "待确认" : "缺少音频"}</span>
                <div className="button-row">
                  {ready
                    ? <button type="button" className="secondary-button" onClick={() => onRemove(exam.id)}>移除绑定</button>
                    : <button type="button" className="module-button" onClick={() => onAdd(exam.id)}>添加音频</button>}
                </div>
              </article>
            );
          })}
          {visible.length === 0 && <div className="empty-state compact"><Icon name="headphones" /><p>没有符合条件的听力试卷。</p></div>}
        </div>
      </section>
    </div>
  );
}
