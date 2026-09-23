/**
 * 今日工作台 — the first screen. Within ten seconds it must answer "今天该干
 * 什么": a countdown when an exam date is set, a generated task list whose
 * every row links to a real paper or page, one loud continue button, a stats
 * strip, a real-data heatmap and quick links. Nothing here fabricates a
 * number — zeros and em-dashes are shown as themselves.
 */
import { useCallback, useEffect, useState } from "react";
import {
  analyticsReport,
  listExams,
  listSessions,
  loadProfile,
  mistakeList,
  planGet,
  planSave,
  vocabDue,
} from "../api";
import type { IndexedExam } from "../content";
import { generatePlan, todayEntry } from "../lib/plan";
import { daysUntil, durationLabel, moduleLabel } from "../lib/format";
import { navigate } from "../nav";
import Heatmap from "../components/Heatmap";
import Onboarding from "../components/Onboarding";
import {
  estimateTodayMinutes,
  examMinutes,
  mockSubmitted,
  resumableSession,
  studyStreak,
  type TodayProfile,
} from "../lib/today";
import type {
  AnalyticsReport,
  Profile,
  SessionSummary,
  StudyPlan,
} from "../types";

interface Data {
  exams: IndexedExam[];
  sessions: SessionSummary[];
  profile: Profile | null;
  plan: StudyPlan | null;
  openMistakes: number;
  dueVocab: number;
  analytics: AnalyticsReport | null;
}

const WEEKDAYS = "日一二三四五六";

export default function Today() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [exams, sessions, profile, mistakes, due, analytics, savedPlan] = await Promise.all([
        listExams(),
        listSessions(),
        loadProfile(),
        mistakeList(),
        vocabDue(),
        analyticsReport(0),
        planGet(),
      ]);
      const openMistakes = mistakes.filter((m) => m.status === "open").length;
      const dueVocab = due.length;
      // The saved plan is reused while it still covers today — the task list
      // stays stable within a day and is rebuilt the first time a new day is
      // seen, or when the exam date changed (it drives the plan horizon).
      let plan = savedPlan;
      if (!todayEntry(plan) || (plan?.examDate ?? undefined) !== (profile?.examDate ?? undefined)) {
        plan = generatePlan({
          exams,
          sessions,
          targetBand: profile?.targetBand,
          examDate: profile?.examDate,
          daysPerWeek: savedPlan?.daysPerWeek ?? 7,
          openMistakes,
          dueVocab,
        });
        plan = await planSave(plan).catch(() => plan);
      }
      setData({ exams, sessions, profile, plan, openMistakes, dueVocab, analytics });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <div className="page-stack">
        <section className="workspace-card" style={{ padding: 20 }}>
          <h2>工作台载入失败</h2>
          <p className="import-error">{error}</p>
          <div className="button-row">
            <button type="button" className="secondary-button" onClick={() => location.reload()}>
              重新加载
            </button>
          </div>
        </section>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="page-stack">
        <p className="empty-inline">正在载入工作台…</p>
      </div>
    );
  }

  const { exams, sessions, profile, plan, openMistakes, dueVocab, analytics } = data;
  const today = todayEntry(plan);
  const countdown = daysUntil(profile?.examDate);
  const dailyMinutes = (profile as TodayProfile | null)?.dailyMinutes;
  const resumable = resumableSession(sessions, exams);
  const hasHistory = sessions.length > 0;
  // A brand-new library needs one obvious first step, not a generated plan
  // whose first mock might be a listening paper with no imported audio.
  const starterExam = exams.find((e) => e.module === "reading") ?? exams[0];
  // The estimate must describe the task actually on screen: the starter paper
  // before any history exists, the generated plan afterwards.
  const estimate = hasHistory
    ? estimateTodayMinutes(today, exams, openMistakes, dueVocab)
    : starterExam
      ? examMinutes(starterExam)
      : null;

  const submitted = sessions.filter((s) => s.status === "submitted");
  const doneExamCount = new Set(submitted.map((s) => s.examId)).size;
  const totals = (analytics?.questionTypeAccuracy ?? []).reduce(
    (acc, row) => ({ correct: acc.correct + row.correct, total: acc.total + row.total }),
    { correct: 0, total: 0 },
  );
  const accuracy = totals.total > 0 ? Math.round((totals.correct / totals.total) * 100) : null;
  const streak = studyStreak(sessions);

  const mockDone = mockSubmitted(today, sessions);
  const mockExam = today?.mock ? exams.find((e) => e.id === today.mock?.examId) : undefined;
  const intensive = today?.intensive;
  const intensiveExam = intensive ? exams.find((e) => e.id === intensive.examId) : undefined;
  const restDay = Boolean(
    today && !today.mock && !today.intensive && today.vocabTarget === 0 && today.mistakeTarget === 0,
  );
  const starterLabel =
    starterExam && starterExam.module !== "reading"
      ? `做一套${moduleLabel(starterExam.module)}摸底`
      : "做一套阅读摸底";

  /* One primary action: resume an open session first, else the first
     unfinished task in the same order the rows render, else the library. */
  let primary: { label: string; hint: string; run: () => void };
  if (resumable) {
    const s = resumable;
    primary = {
      label: "继续今天的学习",
      hint: `恢复《${s.title ?? s.examId}》`,
      run: () => navigate("/app/exam", { exam: s.examId, mode: s.mode, session: s.id }),
    };
  } else if (!hasHistory && starterExam) {
    const e = starterExam;
    primary = {
      label: starterLabel,
      hint: e.title,
      run: () => navigate("/app/exam", { exam: e.id, mode: "practice" }),
    };
  } else if (today?.mock && mockExam && !mockDone) {
    const m = today.mock;
    primary = {
      label: "继续今天的学习",
      hint: `模考《${m.title}》`,
      run: () => navigate("/app/exam", { exam: m.examId, mode: "mock" }),
    };
  } else if (intensive && intensiveExam) {
    primary = {
      label: "继续今天的学习",
      hint: `精听《${intensive.title}》Part ${intensive.part}`,
      run: () => navigate("/app/exam", { exam: intensive.examId, mode: "practice" }),
    };
  } else if (openMistakes > 0) {
    primary = {
      label: "继续今天的学习",
      hint: `错题本还有 ${openMistakes} 道待攻克`,
      run: () => navigate("/app/mistakes"),
    };
  } else if (dueVocab > 0) {
    primary = {
      label: "继续今天的学习",
      hint: `生词今日到期 ${dueVocab} 个`,
      run: () => navigate("/app/vocab"),
    };
  } else {
    primary = {
      label: hasHistory ? "去题库选一套卷" : "去题库看看",
      hint: hasHistory ? "今天的任务都完成了" : "从题库开始第一步",
      run: () => navigate("/app/library"),
    };
  }

  const now = new Date();
  const dateLine = `${now.getMonth() + 1}月${now.getDate()}日 周${WEEKDAYS[now.getDay()]}`;
  const badge = (n: number) =>
    n > 0 ? (
      <span
        style={{
          marginLeft: 6,
          padding: "1px 7px",
          borderRadius: 10,
          background: "var(--caution-soft)",
          color: "var(--caution)",
          fontSize: 11,
          fontWeight: 600,
        }}
      >
        {n}
      </span>
    ) : null;
  const stat = (label: string, value: string, sub?: string) => (
    <div key={label} style={{ display: "grid", gap: 2, alignContent: "start" }}>
      <span className="meta">{label}</span>
      <strong
        style={{
          fontSize: 22,
          fontWeight: 600,
          lineHeight: 1.2,
          color: value === "—" ? "var(--muted-2)" : "var(--ink)",
        }}
      >
        {value}
      </strong>
      {sub && <small className="meta">{sub}</small>}
    </div>
  );

  return (
    <div className="dashboard-page page-stack">
      <div className="page-heading">
        <div>
          <span className="eyebrow">IELTS WORKSPACE</span>
          <h1>今天学什么</h1>
          <p>
            {dateLine}
            {profile?.targetBand != null && ` · 目标 Band ${profile.targetBand.toFixed(1)}`}
          </p>
        </div>
      </div>

      {profile === null && <Onboarding onSaved={() => void load()} />}

      {/* ------------------------------------------------------------ 今日主卡 */}
      <section className="workspace-card today-card">
        <div className="card-heading">
          <div>
            <h2>今天做什么</h2>
            <p>
              {estimate != null && `预计约 ${estimate} 分钟`}
              {estimate != null && dailyMinutes != null && " · "}
              {dailyMinutes != null && `每日目标 ${dailyMinutes} 分钟`}
              {estimate == null && dailyMinutes == null && "任务来自你的真实进度，做完自动推进"}
            </p>
          </div>
          {countdown != null && (
            <div className="exam-countdown">
              <small>距考试还有</small>
              <strong>{countdown > 0 ? countdown : 0}</strong>
              <span>
                {countdown > 0 ? "天" : countdown === 0 ? "天 · 就是今天" : "天 · 考试日已过"}
              </span>
              <b>{profile?.examDate}</b>
            </div>
          )}
        </div>

        {!hasHistory ? (
          <div className="today-tasks">
            <button
              type="button"
              className="today-task"
              onClick={() =>
                starterExam
                  ? navigate("/app/exam", { exam: starterExam.id, mode: "practice" })
                  : navigate("/app/library")
              }
            >
              <span className="today-kind">摸底</span>
              <strong>{starterExam ? starterLabel : "去题库挑一套卷"}</strong>
              <small>{starterExam ? starterExam.title : "题库暂空，先去导入试卷"}</small>
            </button>
            <div className="today-task muted">
              <span className="today-kind">说明</span>
              <strong>还没有学习记录</strong>
              <small>提交第一套卷后，这里会按进度给出每天的任务清单</small>
            </div>
          </div>
        ) : (
          <div className="today-tasks">
            {today?.mock &&
              (mockExam ? (
                <button
                  type="button"
                  className={`today-task${mockDone ? " muted" : ""}`}
                  onClick={() => navigate("/app/exam", { exam: mockExam.id, mode: "mock" })}
                >
                  <span className="today-kind">模考{mockDone ? " · 已完成" : ""}</span>
                  <strong>{today.mock.title}</strong>
                  <small>
                    {moduleLabel(today.mock.module)} · {durationLabel(mockExam)}
                  </small>
                </button>
              ) : (
                <div className="today-task muted">
                  <span className="today-kind">模考</span>
                  <strong>{today.mock.title}</strong>
                  <small>试卷已不在题库中</small>
                </div>
              ))}
            {today &&
              !today.mock &&
              (restDay ? (
                <div className="today-task muted">
                  <span className="today-kind">模考</span>
                  <strong>今天休息</strong>
                  <small>计划里的休息日</small>
                </div>
              ) : (
                <div className="today-task muted">
                  <span className="today-kind">模考</span>
                  <strong>今天没有排试卷</strong>
                  <small>该模块的试卷都做完了，可去题库自由练习</small>
                </div>
              ))}
            {intensive &&
              (intensiveExam ? (
                <button
                  type="button"
                  className="today-task"
                  onClick={() =>
                    navigate("/app/exam", { exam: intensive.examId, mode: "practice" })
                  }
                >
                  <span className="today-kind">精听</span>
                  <strong>{intensive.title}</strong>
                  <small>Part {intensive.part}</small>
                </button>
              ) : null)}
            {openMistakes > 0 && (
              <button
                type="button"
                className="today-task"
                onClick={() => navigate("/app/mistakes")}
              >
                <span className="today-kind">错题</span>
                <strong>
                  {Math.min(openMistakes, today?.mistakeTarget ?? openMistakes)} /{" "}
                  {today?.mistakeTarget ?? openMistakes} 题
                </strong>
                <small>待攻克 {openMistakes} 道</small>
              </button>
            )}
            {dueVocab > 0 && (
              <button type="button" className="today-task" onClick={() => navigate("/app/vocab")}>
                <span className="today-kind">生词</span>
                <strong>
                  {Math.min(dueVocab, today?.vocabTarget ?? dueVocab)} /{" "}
                  {today?.vocabTarget ?? dueVocab} 个
                </strong>
                <small>今日到期 {dueVocab} 个</small>
              </button>
            )}
          </div>
        )}

        <div className="button-row" style={{ marginTop: 14, alignItems: "center" }}>
          <button
            type="button"
            className="primary-button"
            style={{ minHeight: 40, padding: "0 24px", fontSize: 13 }}
            onClick={primary.run}
          >
            {primary.label}
          </button>
          <span className="meta">{primary.hint}</span>
        </div>
      </section>

      {/* ------------------------------------------------------------- 总览条 */}
      <section className="workspace-card" style={{ padding: "14px 18px" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))",
            gap: 12,
          }}
        >
          {stat("试卷总数", String(exams.length))}
          {stat("已提交次数", String(submitted.length))}
          {stat("已做卷数", String(doneExamCount), "按试卷去重")}
          {stat(
            "总正确率",
            accuracy == null ? "—" : `${accuracy}%`,
            totals.total > 0 ? `${totals.correct}/${totals.total} 题` : "提交后显示",
          )}
          {stat("连续学习", `${streak} 天`, streak === 0 ? "从今天开始" : undefined)}
        </div>
      </section>

      {/* ------------------------------------------------------------ 热力图 */}
      <section className="workspace-card" style={{ padding: "16px 18px 12px" }}>
        <div className="card-heading">
          <div>
            <h2>学习热力图</h2>
            <p>最近 20 周 · 按当天会话的答题数（answered）着色，无记录为空</p>
          </div>
        </div>
        <Heatmap sessions={sessions} />
      </section>

      {/* ---------------------------------------------------------- 快捷入口 */}
      <section className="workspace-card" style={{ padding: "14px 18px" }}>
        <div className="button-row" style={{ marginTop: 0, flexWrap: "wrap" }}>
          <button type="button" className="secondary-button" onClick={() => navigate("/app/library")}>
            题库 · {exams.length} 套
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => navigate("/app/mistakes")}
          >
            错题本{badge(openMistakes)}
          </button>
          <button type="button" className="secondary-button" onClick={() => navigate("/app/vocab")}>
            生词{badge(dueVocab)}
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => navigate("/app/analytics")}
          >
            分析
          </button>
        </div>
      </section>
    </div>
  );
}
