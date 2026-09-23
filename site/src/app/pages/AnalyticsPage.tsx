/**
 * 分析报告 — web port of the desktop `AnalyticsPage`, enhanced per WEB-V2:
 * every accuracy row carries a "练这个题型" link into the filtered library,
 * and question types below 60% accuracy with a real sample size get pinned
 * to a 薄弱题型 section on top.
 */
import { useEffect, useMemo, useState } from "react";
import type { Route } from "../nav";
import { analyticsReport } from "../api";
import { questionTypeLabel, rangeLabel } from "../lib/format";
import { practiceTypeHref } from "../lib/review";
import { MiniTrend } from "../components/Charts";
import { Icon, PageHeading } from "../components/ReviewShared";
import type { AnalyticsReport } from "../types";
import type React from "react";

const RANGES = [7, 30, 90, 365, 0];

export default function AnalyticsPage({ route }: { route: Route }) {
  void route; // page ignores the query string today
  const [rangeDays, setRangeDays] = useState(30);
  const [report, setReport] = useState<AnalyticsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [questionType, setQuestionType] = useState("all");

  useEffect(() => {
    let live = true;
    setLoading(true);
    analyticsReport(rangeDays)
      .then((r) => { if (live) { setReport(r); setError(null); } })
      .catch((e) => { if (live) setError(`统计数据读取失败：${String(e)}`); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [rangeDays]);

  const objective = report?.moduleAverages;
  const sessionCount = Object.values(report?.moduleCounts ?? {}).reduce((sum, n) => sum + (n ?? 0), 0);
  const unbanded = Object.values(report?.unbandedCounts ?? {}).reduce((sum, n) => sum + (n ?? 0), 0);
  const types = useMemo(() => Array.from(new Set((report?.questionTypeAccuracy ?? []).map((row) => row.questionType))).sort(), [report]);
  const accuracyRows = (report?.questionTypeAccuracy ?? []).filter((row) => questionType === "all" || row.questionType === questionType);
  // Weak types: enough attempts to mean something, still under 60%.
  const weakRows = useMemo(
    () => (report?.questionTypeAccuracy ?? [])
      .filter((row) => row.total >= 5 && row.accuracy < 0.6)
      .sort((a, b) => a.accuracy - b.accuracy || b.total - a.total),
    [report]);

  useEffect(() => { if (questionType !== "all" && !types.includes(questionType)) setQuestionType("all"); }, [types, questionType]);

  const toolbar = <div className="analytics-toolbar">
    <label className="select-field"><span className="sr-only">时间范围</span><select value={rangeDays} onChange={(e) => setRangeDays(Number(e.target.value))}>
      {RANGES.map((d) => <option key={d} value={d}>{rangeLabel(d)}</option>)}
    </select></label>
    <label className="select-field"><span className="sr-only">题型</span><select value={questionType} onChange={(e) => setQuestionType(e.target.value)}>
      <option value="all">所有题型</option>{types.map((tp) => <option key={tp} value={tp}>{questionTypeLabel(tp)}</option>)}
    </select></label>
  </div>;

  return <div className="analytics-page page-stack">
    <PageHeading title="分析报告" subtitle="基于你的练习与模考数据，全面分析学习表现，识别优势与薄弱环节。" aside={toolbar} />
    {error && <p className="form-error">{error}</p>}
    {loading && !report && <div className="workspace-card empty-state compact"><p className="meta">正在统计已提交的会话…</p></div>}
    {!loading && (!report || sessionCount === 0)
      ? <div className="workspace-card empty-state"><Icon name="chart" size={42} /><h2>{rangeDays === 0 ? "还没有可分析的真实会话" : `${rangeLabel(rangeDays)}内没有已提交的会话`}</h2><p>完成并提交 Listening 或 Reading 后，这里会显示估算 Band 趋势和题型正确率。Writing 只统计完成次数，不产生 Band。{rangeDays !== 0 && "把时间范围切换到「全部记录」可以看到更早的会话。"}</p></div>
      : report && sessionCount > 0 && <>
        {weakRows.length > 0 && <section className="workspace-card weakness-card">
          <div className="card-heading"><h2>薄弱题型</h2><span className="meta">正确率低于 60% 且作答 ≥5 题，按正确率升序</span></div>
          <div className="weakness-list">{weakRows.slice(0, 6).map((row) => <a
            key={`${row.module}-${row.questionType}`} className="weakness-row" href={practiceTypeHref(row.questionType)} title={`去题库练 ${questionTypeLabel(row.questionType)}`}>
            <span>{row.module === "listening" ? "听力" : "阅读"} · {questionTypeLabel(row.questionType)}</span>
            <i><b style={{ width: `${Math.round(row.accuracy * 100)}%` }} /></i>
            <strong>{Math.round(row.accuracy * 100)}% · {row.correct}/{row.total}</strong>
            <Icon name="arrow" size={15} />
          </a>)}</div>
        </section>}
        <div className="analytics-grid">
          <section className="workspace-card trend-card"><div className="card-heading"><h2>估算 Band 趋势</h2><span className="meta">按提交时间 · {rangeLabel(rangeDays)}</span></div><MiniTrend points={report.timeTrend} large /></section>
          <section className="workspace-card module-score-card"><h2>各单项平均估算 Band</h2><div className="score-rings">{(["listening", "reading", "writing"] as const).map((m) => { const band = m === "writing" ? null : objective?.[m] ?? null; return <div key={m} className={`score-ring ${m}`} style={{ ["--ring-fill" as string]: band == null ? "0" : String(Math.min(1, Math.max(0, band / 9))) } as React.CSSProperties}><strong>{band == null ? "—" : band.toFixed(1)}</strong><span>{m === "listening" ? "听力" : m === "reading" ? "阅读" : "写作"}</span><small>{report.moduleCounts[m] ?? 0} 次</small></div>; })}</div><small className="ring-note">写作不产生客观 Band，显示 —。口语未启用，不进入统计。</small></section>
          <section className="workspace-card overall-card"><h2>总体表现</h2><strong className={report.overallAverage == null ? "no-data" : undefined}>{report.overallAverage?.toFixed(1) ?? "—"}</strong><p>{rangeLabel(rangeDays)}内 {sessionCount} 次已提交会话</p><small>非官方估算，按 schema/band-conversion.json 换算；口语未启用，不进入总分。{unbanded > 0 && ` 另有 ${unbanded} 次原始分低于换算表，未计入平均。`}</small></section>
        </div>
        <div className="analytics-grid lower">
          <section className="workspace-card accuracy-card"><div className="card-heading"><h2>题型正确率</h2>{questionType !== "all" && <span className="meta">已筛选：{questionTypeLabel(questionType)}</span>}</div>{accuracyRows.length === 0 && <p className="meta">暂无题型数据</p>}{accuracyRows.slice(0, 12).map((row) => <div className="accuracy-row" key={`${row.module}-${row.questionType}`}><span>{row.module === "listening" ? "听力" : "阅读"} · {questionTypeLabel(row.questionType)}</span><i><b style={{ width: `${Math.round(row.accuracy * 100)}%` }} /></i><strong>{Math.round(row.accuracy * 100)}%</strong><a className="link-button" style={{ gridColumn: "1 / -1", justifySelf: "end", marginTop: -10 }} href={practiceTypeHref(row.questionType)}><Icon name="arrow" size={14} />练这个题型</a></div>)}</section>
        </div>
      </>}
  </div>;
}
