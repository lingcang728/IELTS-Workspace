import { useEffect, useState } from "react";
import { analyticsReport, bootstrap, importExam, loadExam, loadSession, saveProfile, saveSession, scoreExam } from "./lib/api";
import { buildReviewPrompt } from "./lib/reviewPrompt";
import type { AnalyticsReport, Bootstrap, Exam, ExamSummary, Profile, ScoreReport, Session, SessionSummary } from "./lib/types";
import { allQuestions } from "./lib/types";
import type { UiTheme, View } from "./lib/view";
import { ExamApp } from "./exam/ExamApp";
import { BrandMark, Icon, runWindowAction } from "./components/Ui";
import { DesktopTitlebar, Sidebar } from "./components/Shell";
import { Workbench } from "./pages/Workbench";
import { PracticeCenter } from "./pages/PracticeCenter";
import { MockCenter } from "./pages/MockCenter";
import { AnalyticsPage } from "./pages/Analytics";
import { History } from "./pages/History";
import { ImportPage } from "./pages/ImportPage";
import { Settings } from "./pages/Settings";
import { Results } from "./pages/Results";
import { checkForDesktopUpdate } from "./lib/updateService";

function applyUi(theme: UiTheme) {
  document.documentElement.dataset.ui = theme;
}

/**
 * The shell: global state, the IPC calls that mutate it, and the view switch.
 * Every screen lives in `src/pages/`; anything drawn by more than one of them
 * lives in `src/components/`. Keep rendering out of this file.
 */
export function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("home");
  const [exam, setExam] = useState<Exam | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [report, setReport] = useState<ScoreReport | null>(null);
  const [analytics, setAnalytics] = useState<AnalyticsReport | null>(null);
  const [rangeDays, setRangeDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [importText, setImportText] = useState("");
  const [recovery, setRecovery] = useState<SessionSummary[]>([]);
  const [toast, setToast] = useState<string | null>(null);

  function flash(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(null), 2200);
  }

  async function reload() {
    const raw = await bootstrap();
    const availableIds = new Set(raw.exams.map((exam) => exam.id));
    const next = { ...raw, sessions: raw.sessions.filter((session) => availableIds.has(session.examId)) };
    setBoot(next);
    applyUi(next.profile?.theme === "light" ? "light" : "dark");
    setRecovery(next.sessions.filter((s) => availableIds.has(s.examId) && (s.status === "in_progress" || s.status === "interrupted" || s.status === "created")));
    return next;
  }

  useEffect(() => {
    applyUi("dark");
    void reload().catch((e) => setError(String(e)));
    void checkForDesktopUpdate(false);
  }, []);

  // The range filter is a real filter: analytics_report re-reads the sessions
  // for the requested window rather than the frontend hiding rows.
  useEffect(() => {
    if (!boot) return;
    void analyticsReport(rangeDays).then(setAnalytics).catch(() => setAnalytics(null));
  }, [boot, rangeDays]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "F11") return;
      event.preventDefault();
      void runWindowAction("fullscreen").catch(() => undefined);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function updateProfile(patch: Partial<Profile>) {
    const next: Profile = { ...(boot?.profile ?? {}), ...patch };
    if (next.theme) applyUi(next.theme);
    await saveProfile(next);
    await reload();
  }

  async function startExam(summary: ExamSummary, mode: "mock" | "practice") {
    if (busy) return;
    setBusy(true);
    try {
      const ex = await loadExam(summary.id);
      const duration = ex.policy.endCondition.type === "fixed_duration" ? ex.policy.endCondition.durationMs : 0;
      const now = new Date().toISOString();
      const questions = allQuestions(ex);
      const sess: Session = {
        schemaVersion: 1, id: `s-${Date.now()}`, examId: ex.id, examRevision: ex.contentRevision,
        examTitle: ex.title, module: ex.module, mode, status: "in_progress", integrity: "clean",
        startedAt: now, updatedAt: now, remainingMs: duration,
        answers: Object.fromEntries(questions.map((q) => [q.id, { questionId: q.id, questionType: q.type, value: null, flagged: false, updatedAt: now }])),
        highlights: [], notes: [], events: [{ t: now, type: "start", sectionId: ex.sections[0]?.id, questionId: questions[0]?.id }],
        audio: ex.module === "listening" ? { positionMs: 0, partIndex: 0 } : undefined,
        writing: {}, fontScale: 1, colorScheme: "default", saveError: null,
      };
      await saveSession(sess);
      setExam(ex);
      setSession(sess);
      setView("exam");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function continueSession(id: string) {
    if (busy) return;
    setBusy(true);
    try {
      const sess = await loadSession(id);
      const ex = await loadExam(sess.examId);
      if (sess.examRevision && ex.contentRevision && sess.examRevision !== ex.contentRevision) {
        const interrupted = { ...sess, status: "interrupted" as const, integrity: "interrupted" as const, updatedAt: new Date().toISOString() };
        await saveSession(interrupted);
        flash("题目内容已更新，这次记录已安全保留为中断状态");
        await reload();
        return;
      }
      const next = { ...sess, integrity: "interrupted" as const, status: "in_progress" as const, examRevision: ex.contentRevision ?? sess.examRevision };
      await saveSession(next);
      setExam(ex);
      setSession(next);
      setView("exam");
      setRecovery([]);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function openHistory(id: string) {
    const sess = await loadSession(id);
    const ex = await loadExam(sess.examId);
    setExam(ex);
    setSession(sess);
    if (sess.status === "submitted" && ex.module !== "writing") {
      const answers: Record<string, unknown> = {};
      for (const [qid, answer] of Object.entries(sess.answers)) answers[qid] = answer.value;
      try { setReport(await scoreExam(ex.id, answers)); } catch { setReport(null); }
    } else setReport(null);
    if (sess.status === "in_progress" || sess.status === "interrupted" || sess.status === "created") await continueSession(id);
    else setView("results");
  }

  async function copyPrompt() {
    if (!exam || !session) return;
    try {
      await navigator.clipboard.writeText(buildReviewPrompt(exam, session, report));
      flash("批改 Prompt 已复制");
    } catch { flash("复制失败，请手动选中文本"); }
  }

  if (error) return <div className="boot-screen"><div className="error-panel"><BrandMark size={52} /><h1>启动遇到问题</h1><p>{error}</p><button type="button" onClick={() => location.reload()}>重新加载</button></div></div>;
  if (!boot) return <div className="boot-screen"><BrandMark size={64} /><div className="loading-line"><i /></div><span>正在打开本地工作区…</span></div>;
  if (!boot.probe.ok) return <div className="boot-screen"><div className="error-panel"><h1>无法安全启动</h1><p>{boot.probe.error || "当前目录不可写，无法安全保存考试数据。"}</p><small>程序：{boot.probe.appRoot}<br />数据：{boot.probe.dataRoot}</small></div></div>;
  const theme: UiTheme = boot.profile?.theme === "light" ? "light" : "dark";

  if (view === "exam" && exam && session) return <ExamApp exam={exam} session={session} onSession={setSession} onExit={(s, r) => { setSession(s); setReport(r ?? null); setView("results"); void reload(); }} />;

  return <div className="app-shell">
    <DesktopTitlebar />
    <div className="app-frame">
      <Sidebar view={view} setView={setView} />
      <main className="workspace-main">
        {boot.probe.warning && <div className="notice-strip"><Icon name="info" size={16} />{boot.probe.warning}</div>}
        {view === "home" && <Workbench boot={boot} analytics={analytics} busy={busy} onStart={startExam} onView={setView} rangeDays={rangeDays} />}
        {view === "practice" && <PracticeCenter exams={boot.exams} sessions={boot.sessions} busy={busy} onStart={startExam} onContinue={continueSession} onView={setView} />}
        {view === "mock" && <MockCenter exams={boot.exams} sessions={boot.sessions} recovery={recovery} busy={busy} onStart={startExam} onContinue={continueSession} onView={setView} />}
        {view === "analytics" && <AnalyticsPage report={analytics} rangeDays={rangeDays} onRangeDays={setRangeDays} />}
        {view === "history" && <History sessions={boot.sessions} onOpen={(id) => void openHistory(id)} />}
        {view === "import" && <ImportPage value={importText} onChange={setImportText} onImport={() => importExam(importText).then(reload).then(() => setView("home")).catch((e) => setError(String(e)))} />}
        {view === "settings" && <Settings profile={boot.profile} theme={theme} onProfile={(patch) => void updateProfile(patch)} onImport={() => setView("import")} />}
        {view === "results" && session && <Results session={session} report={report} exam={exam} profile={boot.profile} onCopy={() => void copyPrompt()} onHome={() => { setView("home"); setReport(null); }} />}
      </main>
    </div>
    <div className="toast-region">{toast && <div className="toast"><Icon name="check" size={17} />{toast}</div>}</div>
    {busy && <div className="busy-indicator" role="status"><i /><span>正在准备试卷…</span></div>}
  </div>;
}
