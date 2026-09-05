import { Icon, ModuleIcon } from "./Ui";
import { listeningReady } from "../lib/audio";
import type { CatalogGroup, CatalogTestRow } from "../lib/catalog";
import { completion, durationLabel, formatDate, isFinished, moduleLabel, sourceLabel, statusLabel } from "../lib/format";
import type { ExamSummary, SessionSummary } from "../lib/types";

const MODULE_BUTTONS: { module: "reading" | "listening" | "writing"; label: string }[] = [
  { module: "reading", label: "阅读" },
  { module: "listening", label: "听力" },
  { module: "writing", label: "写作" },
];

export function ModuleCard({ module, exam, onStart, disabled, action }: { module: "reading" | "listening" | "writing"; exam?: ExamSummary; onStart: () => void; disabled?: boolean; action?: string }) {
  const meta = { reading: ["阅读", "学术类阅读", "60 分钟 · 3 篇文章 · 40 题"], listening: ["听力", "学术类听力", "约 30 分钟 · 4 部分 · 40 题"], writing: ["写作", "学术类写作", "60 分钟 · Task 1 & Task 2"] }[module];
  return <article className={`module-card ${module}`}><div className="module-card-main"><span className="module-icon-shell"><ModuleIcon module={module} size={56} /></span><div><h3>{meta[0]}</h3><span>{meta[1]}</span></div></div><small>{meta[2]}</small><button type="button" disabled={disabled || !exam} onClick={onStart}>{action ?? "开始练习"}</button></article>;
}

export function ExamRow({ exam, action, onClick }: { exam: ExamSummary; action: string; onClick: () => void }) {
  return <article className="exam-row"><ModuleIcon module={exam.module} size={44} /><div className="exam-row-copy"><span className="tag">{sourceLabel(exam)}</span><h3>{exam.title}</h3><p>{moduleLabel(exam.module)} · {exam.questionCount} 题</p></div><button type="button" className="secondary-button" onClick={onClick}>{action}</button></article>;
}

export function ExamCatalogRow({ exam, mode, action, busy, onClick, onRetake }: { exam: ExamSummary; mode: "mock" | "practice"; action: string; busy: boolean; onClick: () => void; onRetake?: () => void }) {
  const locked = action === "添加音频";
  return <article className={`catalog-row ${exam.module}`}><ModuleIcon module={exam.module} size={42} /><div className="catalog-title"><h3>{exam.title}</h3><small>{sourceLabel(exam)}</small></div><span><small>模块</small>{moduleLabel(exam.module)}</span><span><small>时长</small>{durationLabel(exam)}</span><span><small>题量</small>{exam.questionCount || "—"} {exam.module === "writing" ? "任务" : "题"}</span><div className="catalog-actions"><button type="button" className={mode === "mock" ? "strict-button" : "module-button"} disabled={busy} onClick={onClick}>{action}</button>{onRetake && !locked && <button type="button" className="secondary-button retake-button" disabled={busy} onClick={onRetake}>重考</button>}</div></article>;
}

export function BookCatalog({
  groups,
  mode,
  busy,
  onStart,
  onRetake,
  audioAction,
  startAction,
}: {
  groups: CatalogGroup[];
  mode: "mock" | "practice";
  busy: boolean;
  onStart: (exam: ExamSummary) => void;
  onRetake?: (exam: ExamSummary) => void;
  audioAction: string;
  startAction: string;
}) {
  return (
    <div className="catalog-books">
      {groups.map((group) => group.kind === "cambridge"
        ? <CambridgeBook key={group.key} group={group} busy={busy} onStart={onStart} audioAction={audioAction} />
        : <FlatCatalogGroup key={group.key} group={group} mode={mode} busy={busy} onStart={onStart} onRetake={onRetake} audioAction={audioAction} startAction={startAction} />)}
    </div>
  );
}

function CambridgeBook({
  group,
  busy,
  onStart,
  audioAction,
}: {
  group: CatalogGroup;
  busy: boolean;
  onStart: (exam: ExamSummary) => void;
  audioAction: string;
}) {
  return (
    <section className="workspace-card catalog-book">
      <div className="catalog-book-head">
        <h2>{group.label}</h2>
        <span>{group.tests.length} / 4 套</span>
      </div>
      <div className="catalog-tests">
        {group.tests.map((test) => (
          <div key={test.key} className="catalog-test">
            <strong>{test.label}</strong>
            <TestModuleButtons test={test} busy={busy} onStart={onStart} audioAction={audioAction} />
          </div>
        ))}
      </div>
    </section>
  );
}

function TestModuleButtons({
  test,
  busy,
  onStart,
  audioAction,
}: {
  test: CatalogTestRow;
  busy: boolean;
  onStart: (exam: ExamSummary) => void;
  audioAction: string;
}) {
  return (
    <div className="catalog-test-modules">
      {MODULE_BUTTONS.map(({ module, label }) => {
        const exam = test.exams.find((item) => item.module === module);
        if (!exam) return null;
        const needAudio = module === "listening" && !listeningReady(exam.audioStatus);
        return (
          <button
            key={module}
            type="button"
            className={`catalog-mod ${module}${needAudio ? " locked" : ""}`}
            disabled={busy}
            onClick={() => onStart(exam)}
          >
            {needAudio ? audioAction : label}
          </button>
        );
      })}
    </div>
  );
}

function FlatCatalogGroup({
  group,
  mode,
  busy,
  onStart,
  onRetake,
  audioAction,
  startAction,
}: {
  group: CatalogGroup;
  mode: "mock" | "practice";
  busy: boolean;
  onStart: (exam: ExamSummary) => void;
  onRetake?: (exam: ExamSummary) => void;
  audioAction: string;
  startAction: string;
}) {
  const exams = group.tests.flatMap((test) => test.exams);
  return (
    <section className="workspace-card catalog-book">
      <div className="catalog-book-head">
        <h2>{group.label}</h2>
        <span>{exams.length} 套</span>
      </div>
      <div className="catalog-list">
        {exams.map((exam) => {
          const action = exam.module === "listening" && !listeningReady(exam.audioStatus) ? audioAction : startAction;
          return (
            <ExamCatalogRow
              key={exam.id}
              exam={exam}
              mode={mode}
              action={action}
              busy={busy}
              onClick={() => onStart(exam)}
              onRetake={onRetake ? () => onRetake(exam) : undefined}
            />
          );
        })}
      </div>
    </section>
  );
}

export function SessionRow({ session, action, onClick }: { session: SessionSummary; action: string; onClick: () => void }) {
  return <article className="exam-row session-row"><span className="session-icon"><Icon name={session.status === "submitted" ? "check" : "clock"} size={22} /></span><div className="exam-row-copy"><h3>{session.title || session.examId}</h3><p>{session.mode === "mock" ? "模考" : "练习"} · {formatDate(session.updatedAt)}</p><ProgressBar session={session} /></div><button type="button" className="secondary-button" onClick={onClick}>{action}</button></article>;
}

/**
 * How much of the paper was attempted.
 *
 * Shown wherever a session is listed, because the count of "finished" papers is
 * only trustworthy if the learner can see what it is counting.
 */
export function ProgressBar({ session }: { session: SessionSummary }) {
  const ratio = completion(session);
  if (ratio === null) return null;
  const percent = Math.round(ratio * 100);
  const state = isFinished(session) ? "done" : session.status === "submitted" ? "partial" : "open";
  return <span className={`progress-line ${state}`} title={`${session.answered}/${session.total} 题`}>
    <i><b style={{ width: `${percent}%` }} /></i>
    <small>{session.answered}/{session.total}</small>
  </span>;
}

export function RecordTable({ sessions }: { sessions: SessionSummary[] }) {
  if (!sessions.length) return <p className="empty-inline">完成一次模考后，记录会显示在这里。</p>;
  return <div className="record-table"><div className="record-head"><span>模考名称</span><span>完成时间</span><span>模块</span><span>完成度</span></div>{sessions.map((s) => <div className="record-line" key={s.id}><strong>{s.title || s.examId}</strong><span>{formatDate(s.updatedAt)}</span><span>{moduleLabel(s.module)}</span><b className={isFinished(s) ? "" : "partial"}>{completion(s) === null ? statusLabel(s.status) : `${Math.round((completion(s) ?? 0) * 100)}%`}</b></div>)}</div>;
}

export function RecentMockList({ sessions }: { sessions: SessionSummary[] }) {
  if (!sessions.length) return <p className="empty-inline">完成一次模考后，成绩会显示在这里。</p>;
  return <div className="recent-mock-list">{sessions.map((session) => <article key={session.id}><ModuleIcon module={session.module} size={42} /><span><strong>{session.title || session.examId}</strong><small>完成时间：{formatDate(session.updatedAt)}</small></span><b>{statusLabel(session.status)}</b></article>)}</div>;
}
