import { Icon } from "../components/Ui";
import { PageHeading } from "../components/Shell";
import { ExamRow, ModuleCard, RecordTable, SessionRow } from "../components/ExamRows";
import { MiniTrend } from "../components/Charts";
import { daysUntil, isFinished, rangeLabel } from "../lib/format";
import { listeningReady } from "../lib/audio";
import { todayEntry } from "../lib/plan";
import { quoteOfTheDay } from "../lib/quotes";
import type { AnalyticsReport, Bootstrap, ExamSummary, StudyPlan } from "../lib/types";
import type { View } from "../lib/view";

export function Workbench({ boot, analytics, busy, onStart, onView, rangeDays, plan, openMistakes, dueVocab, onRebuildPlan, onDismissGuide, onAddAudio }: { boot: Bootstrap; analytics: AnalyticsReport | null; busy: boolean; onStart: (e: ExamSummary, mode: "mock" | "practice") => void; onView: (v: View) => void; rangeDays: number; plan: StudyPlan | null; openMistakes: number; dueVocab: number; onRebuildPlan: () => void; onDismissGuide?: () => void; onAddAudio?: () => void }) {
  const first = (module: ExamSummary["module"]) => boot.exams.find((e) => e.module === module);
  const recent = boot.sessions.filter((s) => s.status === "submitted").slice(0, 4);
  const avg = analytics?.overallAverage;
  const countdown = daysUntil(boot.profile?.examDate);
  const today = todayEntry(plan);
  const todaysExam = today?.mock ? boot.exams.find((e) => e.id === today.mock?.examId) : undefined;
  const quote = quoteOfTheDay();
  const finished = boot.sessions.filter(isFinished).length;
  const listeningMissing = boot.exams.some((e) => e.module === "listening" && !listeningReady(e.audioStatus));
  const showGuide = listeningMissing && !boot.profile?.audioGuideDismissed;
  return <div className="dashboard-page page-stack"><PageHeading title={<>欢迎回来！ <span className="wave-mark">👋</span></>} subtitle={<>在这里开始你的 <em>IELTS Academic</em> 练习与模考</>} aside={countdown == null ? null
      : <div className="exam-countdown"><small>距考试还有</small><strong>{countdown > 0 ? countdown : 0}</strong><span>{countdown > 0 ? "天" : countdown === 0 ? "天 · 就是今天" : "天 · 考试日已过"}</span><b>{boot.profile?.examDate}</b></div>} />
    {showGuide && <section className="workspace-card audio-guide-card">
      <div>
        <h2>添加 Listening 音频</h2>
        <p>阅读和写作安装后即可用。听力题目已内置，音频需要你从本机导入，或按分册 ZIP 添加。应用不会联网下载。</p>
      </div>
      <div className="button-row">
        <button type="button" className="primary-button" onClick={() => onAddAudio ? onAddAudio() : onView("audio")}>添加音频</button>
        <button type="button" className="link-button" onClick={() => onView("audio")}>打开听力资源</button>
        <button type="button" className="link-button" onClick={() => onDismissGuide?.()}>不再显示</button>
      </div>
    </section>}
    <section className={`quote-card marker-${quote.marker}`}>
      <span className="quote-open" aria-hidden="true">&ldquo;</span>
      <blockquote>
        {quote.before}<mark>{quote.mark}</mark>{quote.after}
        <cite>— {quote.author}</cite>
      </blockquote>
      <div className="quote-tally">
        {finished > 0 && <span><strong>{finished}</strong> 套完整做完</span>}
        {dueVocab > 0 && <span><strong>{dueVocab}</strong> 个生词等你</span>}
        {openMistakes > 0 && <span><strong>{openMistakes}</strong> 道错题待攻克</span>}
        {finished === 0 && dueVocab === 0 && openMistakes === 0 && <span>今天是个不错的开始。</span>}
      </div>
    </section>
    <section className="workspace-card today-card">
      <div className="card-heading">
        <div><h2>今天做什么</h2><p>{plan
          ? `按你的计划，每周 ${plan.daysPerWeek} 天`
          : "还没有学习计划。生成一份，工作台首屏就会直接告诉你今天该干什么。"}</p></div>
        <button type="button" className="link-button" onClick={onRebuildPlan}>
          {plan ? "重新生成" : "生成计划"} <Icon name="rotate" size={14} /></button>
      </div>
      {plan && !today && <p className="empty-inline">计划没有覆盖到今天，重新生成一份。</p>}
      {today && <div className="today-tasks">
        {todaysExam
          ? <button type="button" className="today-task" disabled={busy}
                    onClick={() => onStart(todaysExam, "mock")}>
              <span className="today-kind">模考</span>
              <strong>{todaysExam.title}</strong>
              <small>{today.mock?.module}</small>
            </button>
          : <div className="today-task muted"><span className="today-kind">模考</span>
              <strong>今天休息</strong><small>计划里的休息日</small></div>}
        {today.intensive && <button type="button" className="today-task" onClick={() => onView("intensive")}>
          <span className="today-kind">精听</span>
          <strong>{today.intensive.title}</strong>
          <small>Part {today.intensive.part}</small>
        </button>}
        <button type="button" className="today-task" onClick={() => onView("mistakes")}>
          <span className="today-kind">错题</span>
          <strong>{Math.min(openMistakes, today.mistakeTarget)} / {today.mistakeTarget} 题</strong>
          <small>待攻克 {openMistakes} 道</small>
        </button>
        <button type="button" className="today-task" onClick={() => onView("vocab")}>
          <span className="today-kind">生词</span>
          <strong>{Math.min(dueVocab, today.vocabTarget)} / {today.vocabTarget} 个</strong>
          <small>今日到期 {dueVocab} 个</small>
        </button>
      </div>}
    </section>
    <div className="dashboard-grid top-grid"><section className="workspace-card quick-start"><div className="card-heading"><div><h2>快速开始</h2><p>选择题型，立即开始练习或模考</p></div></div><div className="module-grid">{(["reading", "listening", "writing"] as const).map((m) => { const ex = first(m); const needAudio = m === "listening" && ex && !listeningReady(ex.audioStatus); return <ModuleCard key={m} module={m} exam={ex} disabled={busy} action={needAudio ? "添加音频" : "开始练习"} onStart={() => ex && onStart(ex, "practice")} />; })}</div></section><section className="workspace-card recent-use"><div className="card-heading"><h2>官方样题 / 最近使用</h2><button type="button" className="link-button" onClick={() => onView("mock")}>查看全部 <Icon name="arrow" size={15} /></button></div>{boot.exams.slice(0, 1).map((e) => <ExamRow key={e.id} exam={e} action="开始模考" onClick={() => onStart(e, "mock")} />)}{boot.sessions[0] ? <SessionRow session={boot.sessions[0]} action="继续练习" onClick={() => onView("history")} /> : <p className="empty-inline">完成练习后，这里会保留最近进度。</p>}</section></div>
    <div className="dashboard-grid bottom-grid"><section className="workspace-card recent-records"><div className="card-heading"><h2>最近模考记录</h2><button type="button" className="link-button" onClick={() => onView("history")}>查看全部 <Icon name="arrow" size={15} /></button></div><RecordTable sessions={recent} /></section><section className="workspace-card analytics-overview"><div className="card-heading"><h2>分析概览</h2><button type="button" className="link-button" onClick={() => onView("analytics")}>{rangeLabel(rangeDays)} <Icon name="arrow" size={14} /></button></div><div className="analytics-summary"><div className="average-score"><span>平均估算 Band</span><strong className={avg == null ? "no-data" : undefined}>{avg == null ? "—" : avg.toFixed(1)}</strong><small>{avg == null ? "提交考试后显示真实数据" : "非官方估算，来自已提交的真实会话"}</small></div><MiniTrend points={analytics?.timeTrend ?? []} /></div></section></div>
  </div>;
}
