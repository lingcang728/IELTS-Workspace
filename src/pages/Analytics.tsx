import { useEffect, useMemo, useState } from "react";
import { Icon } from "../components/Ui";
import { PageHeading } from "../components/Shell";
import { MiniTrend } from "../components/Charts";
import { rangeLabel } from "../lib/format";
import type { AnalyticsReport } from "../lib/types";

export function AnalyticsPage({ report, rangeDays, onRangeDays }: { report: AnalyticsReport | null; rangeDays: number; onRangeDays: (d: number) => void }) {
  const [questionType, setQuestionType] = useState("all");
  const objective = report?.moduleAverages;
  const sessionCount = Object.values(report?.moduleCounts ?? {}).reduce((sum, n) => sum + (n ?? 0), 0);
  const unbanded = Object.values(report?.unbandedCounts ?? {}).reduce((sum, n) => sum + (n ?? 0), 0);
  const types = useMemo(() => Array.from(new Set((report?.questionTypeAccuracy ?? []).map((row) => row.questionType))).sort(), [report]);
  const accuracyRows = (report?.questionTypeAccuracy ?? []).filter((row) => questionType === "all" || row.questionType === questionType);
  useEffect(() => { if (questionType !== "all" && !types.includes(questionType)) setQuestionType("all"); }, [types, questionType]);
  const toolbar = <div className="analytics-toolbar">
    <label className="select-field"><span className="sr-only">时间范围</span><select value={rangeDays} onChange={(e) => onRangeDays(Number(e.target.value))}>
      <option value={7}>过去 7 天</option><option value={30}>过去 30 天</option><option value={90}>过去 90 天</option><option value={365}>过去一年</option><option value={0}>全部记录</option>
    </select></label>
    <label className="select-field"><span className="sr-only">题型</span><select value={questionType} onChange={(e) => setQuestionType(e.target.value)}>
      <option value="all">所有题型</option>{types.map((tp) => <option key={tp} value={tp}>{tp.replaceAll("_", " ")}</option>)}
    </select></label>
  </div>;
  return <div className="analytics-page page-stack"><PageHeading title="分析报告" subtitle="基于你的练习与模考数据，全面分析学习表现，识别优势与薄弱环节。" aside={toolbar} />
    {!report || sessionCount === 0
      ? <div className="workspace-card empty-state"><Icon name="chart" size={42} /><h2>{rangeDays === 0 ? "还没有可分析的真实会话" : `${rangeLabel(rangeDays)}内没有已提交的会话`}</h2><p>完成并提交 Listening 或 Reading 后，这里会显示估算 Band 趋势和题型正确率。Writing 只统计完成次数，不产生 Band。{rangeDays !== 0 && "把时间范围切换到「全部记录」可以看到更早的会话。"}</p></div>
      : <>
        <div className="analytics-grid">
          <section className="workspace-card trend-card"><div className="card-heading"><h2>估算 Band 趋势</h2><span className="meta">按提交时间 · {rangeLabel(rangeDays)}</span></div><MiniTrend points={report.timeTrend} large /></section>
          <section className="workspace-card module-score-card"><h2>各单项平均估算 Band</h2><div className="score-rings">{(["listening", "reading", "writing"] as const).map((m) => <div key={m} className={`score-ring ${m}`}><strong>{m === "writing" ? "—" : objective?.[m]?.toFixed(1) ?? "—"}</strong><span>{m === "listening" ? "听力" : m === "reading" ? "阅读" : "写作"}</span><small>{report.moduleCounts[m] ?? 0} 次</small></div>)}<div className="score-ring speaking"><strong>—</strong><span>口语</span><small>未启用</small></div></div><small className="ring-note">写作与口语不产生客观 Band，故显示 —。</small></section>
          <section className="workspace-card overall-card"><h2>总体表现</h2><strong className={report.overallAverage == null ? "no-data" : undefined}>{report.overallAverage?.toFixed(1) ?? "—"}</strong><p>{rangeLabel(rangeDays)}内 {sessionCount} 次已提交会话</p><small>非官方估算，按 schema/band-conversion.json 换算；口语未启用，不进入总分。{unbanded > 0 && ` 另有 ${unbanded} 次原始分低于换算表，未计入平均。`}</small></section>
        </div>
        <div className="analytics-grid lower">
          <section className="workspace-card accuracy-card"><div className="card-heading"><h2>题型正确率分析</h2>{questionType !== "all" && <span className="meta">已筛选：{questionType.replaceAll("_", " ")}</span>}</div>{accuracyRows.length === 0 && <p className="meta">暂无题型数据</p>}{accuracyRows.slice(0, 12).map((row) => <div className="accuracy-row" key={`${row.module}-${row.questionType}`}><span>{row.questionType.replaceAll("_", " ")}</span><i><b style={{ width: `${Math.round(row.accuracy * 100)}%` }} /></i><strong>{Math.round(row.accuracy * 100)}%</strong></div>)}</section>
          <section className="workspace-card time-card"><h2>Listening &amp; Reading 表现</h2><MiniTrend points={report.timeTrend} /></section>
        </div>
      </>}
  </div>;
}
