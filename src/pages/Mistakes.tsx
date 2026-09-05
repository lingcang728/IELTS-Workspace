import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../components/Ui";
import { PageHeading } from "../components/Shell";
import { mistakeDelete, mistakeList, mistakeResolve } from "../lib/api";
import { formatDate, questionTypeLabel } from "../lib/format";
import { attemptMatches } from "../lib/mistakes";
import type { Mistake, ModuleKind } from "../lib/types";

function answerText(value: Mistake["userAnswer"]) {
  if (value == null || value === "") return "（未作答）";
  return Array.isArray(value) ? value.join(", ") : String(value);
}

type Filter = "open" | "mastered" | "all";

export function Mistakes({ onPractise }: { onPractise: (typeKey: string) => void }) {
  const [rows, setRows] = useState<Mistake[] | null>(null);
  const [filter, setFilter] = useState<Filter>("open");
  const [module, setModule] = useState<ModuleKind | "all">("all");
  const [attempts, setAttempts] = useState<Record<string, string>>({});
  const [verdict, setVerdict] = useState<Record<string, "ok" | "bad">>({});
  const checking = useRef(false);

  async function reload() {
    setRows(await mistakeList().catch(() => []));
  }

  useEffect(() => { void reload(); }, []);

  const visible = useMemo(() => {
    const all = rows ?? [];
    return all.filter((row) =>
      (filter === "all" || row.status === filter) &&
      (module === "all" || row.module === module));
  }, [rows, filter, module]);

  // The weakness view is the point of the book: it is the same
  // questionTypeAccuracy the analytics page already computes, but here it has
  // somewhere to go — every row leads to a practice set of that type.
  const byType = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of rows ?? []) {
      if (row.status !== "open") continue;
      counts.set(row.questionType, (counts.get(row.questionType) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  async function check(row: Mistake) {
    if (checking.current) return;
    checking.current = true;
    try {
      const attempt = attempts[row.id] ?? "";
      const correct = attemptMatches(attempt, row.acceptedAnswers);
      setVerdict((v) => ({ ...v, [row.id]: correct ? "ok" : "bad" }));
      await mistakeResolve(row.id, correct).catch(() => undefined);
      await reload();
    } finally {
      checking.current = false;
    }
  }

  if (rows === null) return <div className="page-stack"><PageHeading title="错题本" /></div>;

  return <div className="page-stack mistakes-page">
    <PageHeading
      title="错题本"
      subtitle="交卷后自动收录，带原文出处。连续答对 3 次自动归档。"
      aside={<div className="analytics-toolbar">
        <label className="select-field"><span className="sr-only">状态</span>
          <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
            <option value="open">待攻克</option><option value="mastered">已归档</option><option value="all">全部</option>
          </select></label>
        <label className="select-field"><span className="sr-only">模块</span>
          <select value={module} onChange={(e) => setModule(e.target.value as ModuleKind | "all")}>
            <option value="all">全部模块</option><option value="listening">听力</option><option value="reading">阅读</option>
          </select></label>
      </div>} />

    {byType.length > 0 && <section className="workspace-card weakness-card">
      <div className="card-heading"><h2>薄弱题型</h2><span className="meta">按待攻克错题数排序</span></div>
      <div className="weakness-list">{byType.slice(0, 6).map(([type, count]) => <button
        key={type} type="button" className="weakness-row" onClick={() => onPractise(type)}>
        <span>{questionTypeLabel(type)}</span>
        <i><b style={{ width: `${Math.min(100, (count / byType[0][1]) * 100)}%` }} /></i>
        <strong>{count} 题</strong>
        <Icon name="arrow" size={15} />
      </button>)}</div>
    </section>}

    {visible.length === 0
      ? <div className="workspace-card empty-state"><Icon name="pen" size={42} />
          <h2>{filter === "mastered" ? "还没有归档的错题" : "没有待攻克的错题"}</h2>
          <p>提交一次听力或阅读后，答错的题会自动收录到这里，并带上原文出处。</p></div>
      : <div className="mistake-list">{visible.map((row) => <article className="workspace-card mistake-row" key={row.id}>
          <header>
            <span className={`mode-label ${row.module === "listening" ? "" : "practice"}`}>{questionTypeLabel(row.questionType)}</span>
            <h3>Q{row.number} · {row.examTitle || row.examId}</h3>
            <small>{formatDate(row.updatedAt)} · 错 {row.timesWrong} 次 · 连对 {row.streak}/3</small>
          </header>
          <p className="mistake-prompt">{row.prompt || "（题面缺失）"}</p>
          {row.sourceExcerpt && <blockquote className="mistake-source">{row.sourceExcerpt}</blockquote>}
          <div className="mistake-answers">
            <span><small>你的答案</small><b className="wrong">{answerText(row.userAnswer)}</b></span>
            <span><small>正确答案</small><b>{row.acceptedAnswers.join(" / ") || "—"}</b></span>
          </div>
          <div className="mistake-redo">
            <input
              value={attempts[row.id] ?? ""}
              placeholder="重做一次，凭记忆作答"
              onChange={(e) => setAttempts((a) => ({ ...a, [row.id]: e.target.value }))}
              onKeyDown={(e) => { if (e.key === "Enter") void check(row); }} />
            <button type="button" className="secondary-button" onClick={() => void check(row)}>核对</button>
            <button type="button" className="link-button" onClick={() => void mistakeDelete(row.id).then(reload)}>移除</button>
            {verdict[row.id] === "ok" && <span className="verdict ok"><Icon name="check" size={15} />正确</span>}
            {verdict[row.id] === "bad" && <span className="verdict bad">再看一遍原文</span>}
          </div>
        </article>)}</div>}
  </div>;
}
