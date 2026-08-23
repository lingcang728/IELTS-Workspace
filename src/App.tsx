import { useEffect, useMemo, useState } from "react";
import { analyticsReport, bootstrap, importExam, loadExam, loadSession, saveProfile, saveSession, scoreExam } from "./lib/api";
import { buildReviewPrompt } from "./lib/reviewPrompt";
import type { AnalyticsReport, Bootstrap, Exam, ExamSummary, ScoreReport, Session, SessionSummary } from "./lib/types";
import { allQuestions } from "./lib/types";
import { ExamApp } from "./exam/ExamApp";
import { BrandMark, Icon, type IconName, ModuleIcon, runWindowAction, WindowControls } from "./components/Ui";
import { UpdatePanel } from "./components/UpdatePanel";
import { checkForDesktopUpdate } from "./lib/updateService";

type View = "home" | "practice" | "mock" | "analytics" | "history" | "settings" | "import" | "results" | "exam";
type UiTheme = "light" | "dark";
type CatalogModule = "all" | "reading" | "listening" | "writing";

function applyUi(theme: UiTheme) {
  document.documentElement.dataset.ui = theme;
}

function DesktopTitlebar() {
  return <header className="window-bar" data-tauri-drag-region>
    <div className="window-brand" data-tauri-drag-region><BrandMark size={18} className="titlebar-mark" /><span>IELTS Workspace</span></div>
    <WindowControls />
  </header>;
}

function Sidebar({ view, setView }: { view: View; setView: (v: View) => void }) {
  const primary: { view: View; icon: IconName; label: string }[] = [
    { view: "home", icon: "grid", label: "工作台" },
    { view: "practice", icon: "pen", label: "练习" },
    { view: "mock", icon: "clock", label: "模考" },
    { view: "analytics", icon: "chart", label: "分析报告" },
  ];
  const nav = (item: { view: View; icon: IconName; label: string }) => <button key={item.view} type="button" className={view === item.view ? "selected" : ""} onClick={() => setView(item.view)}><Icon name={item.icon} size={21} /><span>{item.label}</span></button>;
  return <aside className="sidebar">
    <div className="sidebar-brand"><BrandMark size={56} className="sidebar-mark" /><div><strong>IELTS</strong><span>Workspace</span></div></div>
    <nav className="side-nav" aria-label="主导航">{primary.map(nav)}</nav>
    <div className="sidebar-spacer" />
    <nav className="side-nav" aria-label="辅助导航">
      {nav({ view: "history", icon: "history", label: "历史记录" })}
      {nav({ view: "settings", icon: "settings", label: "设置" })}
    </nav>
  </aside>;
}

export function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("home");
  const [exam, setExam] = useState<Exam | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [report, setReport] = useState<ScoreReport | null>(null);
  const [analytics, setAnalytics] = useState<AnalyticsReport | null>(null);
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
    void analyticsReport(30).then(setAnalytics).catch(() => setAnalytics(null));
    return next;
  }

  useEffect(() => {
    applyUi("dark");
    void reload().catch((e) => setError(String(e)));
    void checkForDesktopUpdate(false);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "F11") return;
      event.preventDefault();
      void runWindowAction("fullscreen").catch(() => undefined);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function setTheme(theme: UiTheme) {
    applyUi(theme);
    await saveProfile({ theme });
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
        {view === "home" && <Workbench boot={boot} analytics={analytics} busy={busy} onStart={startExam} onView={setView} />}
        {view === "practice" && <PracticeCenter exams={boot.exams} sessions={boot.sessions} busy={busy} onStart={startExam} onContinue={continueSession} onView={setView} />}
        {view === "mock" && <MockCenter exams={boot.exams} sessions={boot.sessions} recovery={recovery} busy={busy} onStart={startExam} onContinue={continueSession} onView={setView} />}
        {view === "analytics" && <AnalyticsPage report={analytics} sessions={boot.sessions} />}
        {view === "history" && <History sessions={boot.sessions} onOpen={(id) => void openHistory(id)} />}
        {view === "import" && <ImportPage value={importText} onChange={setImportText} onImport={() => importExam(importText).then(reload).then(() => setView("home")).catch((e) => setError(String(e)))} />}
        {view === "settings" && <Settings theme={theme} onTheme={(t) => void setTheme(t)} onImport={() => setView("import")} />}
        {view === "results" && session && <Results session={session} report={report} exam={exam} onCopy={() => void copyPrompt()} onHome={() => { setView("home"); setReport(null); }} />}
      </main>
    </div>
    <div className="toast-region">{toast && <div className="toast"><Icon name="check" size={17} />{toast}</div>}</div>
    {busy && <div className="busy-indicator" role="status"><i /><span>正在准备试卷…</span></div>}
  </div>;
}

function PageHeading({ eyebrow, title, subtitle, aside }: { eyebrow?: string; title: React.ReactNode; subtitle?: React.ReactNode; aside?: React.ReactNode }) {
  return <div className="page-heading"><div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>{aside}</div>;
}

function ModuleCard({ module, exam, onStart, disabled }: { module: "reading" | "listening" | "writing"; exam?: ExamSummary; onStart: () => void; disabled?: boolean }) {
  const meta = { reading: ["Reading", "学术类阅读", "60 分钟 · 3 篇文章 · 40 题"], listening: ["Listening", "学术类听力", "约 30 分钟 · 4 部分 · 40 题"], writing: ["Writing", "学术类写作", "60 分钟 · Task 1 & Task 2"] }[module];
  return <article className={`module-card ${module}`}><div className="module-card-main"><span className="module-icon-shell"><ModuleIcon module={module} size={56} /></span><div><h3>{meta[0]}</h3><span>{meta[1]}</span></div></div><small>{meta[2]}</small><button type="button" disabled={disabled || !exam} onClick={onStart}>开始练习</button></article>;
}

function Workbench({ boot, analytics, busy, onStart, onView }: { boot: Bootstrap; analytics: AnalyticsReport | null; busy: boolean; onStart: (e: ExamSummary, mode: "mock" | "practice") => void; onView: (v: View) => void }) {
  const first = (module: ExamSummary["module"]) => boot.exams.find((e) => e.module === module);
  const recent = boot.sessions.filter((s) => s.status === "submitted").slice(0, 4);
  const avg = analytics?.overallAverage;
  return <div className="dashboard-page page-stack"><PageHeading title={<>欢迎回来！ <span className="wave-mark">👋</span></>} subtitle={<>在这里开始你的 <em>IELTS Academic</em> 练习与模考</>} aside={<blockquote>Success is the sum of small efforts,<br />repeated day in and day out.<cite>— Robert Collier</cite></blockquote>} />
    <div className="dashboard-grid top-grid"><section className="workspace-card quick-start"><div className="card-heading"><div><h2>快速开始</h2><p>选择题型，立即开始练习或模考</p></div></div><div className="module-grid">{(["reading", "listening", "writing"] as const).map((m) => { const ex = first(m); return <ModuleCard key={m} module={m} exam={ex} disabled={busy} onStart={() => ex && onStart(ex, "practice")} />; })}</div></section><section className="workspace-card recent-use"><div className="card-heading"><h2>官方样题 / 最近使用</h2><button type="button" className="link-button" onClick={() => onView("mock")}>查看全部 <Icon name="arrow" size={15} /></button></div>{boot.exams.slice(0, 1).map((e) => <ExamRow key={e.id} exam={e} action="开始模考" onClick={() => onStart(e, "mock")} />)}{boot.sessions[0] ? <SessionRow session={boot.sessions[0]} action="继续练习" onClick={() => onView("history")} /> : <p className="empty-inline">完成练习后，这里会保留最近进度。</p>}</section></div>
    <div className="dashboard-grid bottom-grid"><section className="workspace-card recent-records"><div className="card-heading"><h2>最近模考记录</h2><button type="button" className="link-button" onClick={() => onView("history")}>查看全部 <Icon name="arrow" size={15} /></button></div><RecordTable sessions={recent} /></section><section className="workspace-card analytics-overview"><div className="card-heading"><h2>分析概览</h2><span className="select-like">近 30 天 <Icon name="chevron" size={14} /></span></div><div className="analytics-summary"><div className="average-score"><span>平均总分</span><strong>{avg == null ? "—" : avg.toFixed(1)}</strong><small>{avg == null ? "提交考试后显示真实数据" : "来自已提交的真实会话"}</small></div><MiniTrend points={analytics?.scoreTrend.reading ?? []} /></div></section></div>
  </div>;
}

function PracticeCenter({ exams, sessions, busy, onStart, onContinue, onView }: { exams: ExamSummary[]; sessions: SessionSummary[]; busy: boolean; onStart: (e: ExamSummary, mode: "mock" | "practice") => void; onContinue: (id: string) => void; onView: (v: View) => void }) {
  const [module, setModule] = useState<CatalogModule>("all"); const [query, setQuery] = useState(""); const [page, setPage] = useState(0);
  const filtered = useMemo(() => exams.filter((e) => (module === "all" || e.module === module) && `${e.title} ${sourceLabel(e)}`.toLowerCase().includes(query.trim().toLowerCase())), [exams, module, query]);
  const pageSize = 6; const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize)); const visible = filtered.slice(page * pageSize, (page + 1) * pageSize);
  const practiceSessions = sessions.filter((s) => s.mode === "practice"); const unfinished = practiceSessions.find((s) => s.status !== "submitted");
  useEffect(() => setPage(0), [module, query]);
  return <div className="practice-page page-stack"><PageHeading title="练习中心" subtitle="自由选择模块与题目，按自己的节奏暂停、重听和复盘" />
    <div className="practice-features"><div><Icon name="target" /><span><strong>自由选题</strong><small>按模块和关键词快速定位</small></span></div><div><Icon name="pause" /><span><strong>可暂停重听</strong><small>练习模式不会强制交卷</small></span></div><div><Icon name="eye" /><span><strong>练后看解析</strong><small>提交后逐题核对答案</small></span></div></div>
    <div className="practice-layout"><section className="workspace-card catalog-card"><CatalogToolbar module={module} setModule={setModule} query={query} setQuery={setQuery} /><div className="catalog-heading"><h2>可用练习</h2><span>{filtered.length} 套</span></div><div className="catalog-list">{visible.map((e) => <ExamCatalogRow key={e.id} exam={e} mode="practice" action="开始练习" busy={busy} onClick={() => onStart(e, "practice")} />)}{visible.length === 0 && <div className="empty-state compact"><Icon name="search" /><p>没有找到符合条件的练习。</p></div>}</div><Pagination page={page} pageCount={pageCount} setPage={setPage} /></section>
      <aside className="practice-aside"><section className="workspace-card continue-card"><div className="card-heading"><h2>继续上次练习</h2><button type="button" className="link-button" onClick={() => onView("history")}>查看全部 <Icon name="arrow" size={14} /></button></div>{unfinished ? <><SessionRow session={unfinished} action="继续练习" onClick={() => onContinue(unfinished.id)} /><div className="progress-line"><i /></div><small>进度会随作答自动保存</small></> : <p className="empty-inline">当前没有未完成练习。</p>}</section><section className="workspace-card weekly-card"><div className="card-heading"><h2>本周练习</h2><span className="meta">本机记录</span></div><WeeklyStat icon="clock" label="练习会话" value={`${practiceSessions.length} 次`} ratio={Math.min(100, practiceSessions.length * 12)} /><WeeklyStat icon="check" label="已完成" value={`${practiceSessions.filter((s) => s.status === "submitted").length} 套`} ratio={practiceSessions.length ? Math.round(practiceSessions.filter((s) => s.status === "submitted").length / practiceSessions.length * 100) : 0} /><WeeklyStat icon="rotate" label="可恢复" value={`${practiceSessions.filter((s) => s.status !== "submitted").length} 套`} ratio={Math.min(100, practiceSessions.filter((s) => s.status !== "submitted").length * 25)} /></section></aside>
    </div></div>;
}

function MockCenter({ exams, sessions, recovery, busy, onStart, onContinue, onView }: { exams: ExamSummary[]; sessions: SessionSummary[]; recovery: SessionSummary[]; busy: boolean; onStart: (e: ExamSummary, mode: "mock" | "practice") => void; onContinue: (id: string) => void; onView: (v: View) => void }) {
  const [module, setModule] = useState<CatalogModule>("all"); const [query, setQuery] = useState(""); const [page, setPage] = useState(0);
  const filtered = useMemo(() => exams.filter((e) => (module === "all" || e.module === module) && `${e.title} ${sourceLabel(e)}`.toLowerCase().includes(query.trim().toLowerCase())), [exams, module, query]);
  const pageSize = 6; const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize)); const visible = filtered.slice(page * pageSize, (page + 1) * pageSize); const completed = sessions.filter((s) => s.mode === "mock" && s.status === "submitted");
  useEffect(() => setPage(0), [module, query]);
  return <div className="mock-page page-stack"><PageHeading title="模考中心" subtitle="官方样题与全真模考，严格按真实考试流程，提升应试能力与时间管理" />
    <div className="mock-layout"><div className="mock-main">{recovery.length > 0 && <section className="workspace-card resume-card"><div><h2>继续未完成模考</h2></div>{recovery.slice(0, 1).map((s) => <SessionRow key={s.id} session={s} action="继续模考" onClick={() => onContinue(s.id)} />)}</section>}<section className="workspace-card catalog-card mock-catalog"><CatalogToolbar module={module} setModule={setModule} query={query} setQuery={setQuery} /><div className="catalog-heading"><h2>可用模考</h2><span>{filtered.length} 套</span></div><div className="catalog-list">{visible.map((e) => <ExamCatalogRow key={e.id} exam={e} mode="mock" action="开始模考" busy={busy} onClick={() => onStart(e, "mock")} />)}</div><Pagination page={page} pageCount={pageCount} setPage={setPage} /></section></div>
      <aside className="mock-aside"><section className="workspace-card recent-mock-card"><div className="card-heading"><h2>最近模考成绩</h2><button type="button" className="link-button" onClick={() => onView("history")}>查看全部 <Icon name="arrow" size={14} /></button></div><RecentMockList sessions={completed.slice(0, 2)} /></section></aside>
    </div></div>;
}

function CatalogToolbar({ module, setModule, query, setQuery }: { module: CatalogModule; setModule: (m: CatalogModule) => void; query: string; setQuery: (q: string) => void }) {
  return <div className="catalog-toolbar"><div className="filter-tabs">{(["all", "reading", "listening", "writing"] as const).map((m) => <button key={m} type="button" className={module === m ? "active" : ""} onClick={() => setModule(m)}>{m === "all" ? "全部" : m[0].toUpperCase() + m.slice(1)}</button>)}</div><label className="catalog-search"><Icon name="search" size={16} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索题目" /></label></div>;
}

function Pagination({ page, pageCount, setPage }: { page: number; pageCount: number; setPage: (p: number) => void }) {
  if (pageCount <= 1) return null;
  return <div className="pagination"><button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button><span>{page + 1} / {pageCount}</span><button type="button" disabled={page + 1 >= pageCount} onClick={() => setPage(page + 1)}>下一页</button></div>;
}

function WeeklyStat({ icon, label, value, ratio }: { icon: IconName; label: string; value: string; ratio: number }) {
  return <div className="weekly-stat"><div><span className="stat-icon"><Icon name={icon} /></span><strong>{label}</strong><b>{value}</b></div><i><span style={{ width: `${ratio}%` }} /></i></div>;
}

function AnalyticsPage({ report, sessions }: { report: AnalyticsReport | null; sessions: SessionSummary[] }) {
  const objective = report?.moduleAverages; const completed = sessions.filter((s) => s.status === "submitted");
  return <div className="analytics-page page-stack"><PageHeading title="分析报告" subtitle="基于你的练习与模考数据，全面分析学习表现，识别优势与薄弱环节。" aside={<div className="analytics-toolbar"><span className="select-like">过去 30 天 <Icon name="chevron" size={14} /></span><span className="select-like">所有题型 <Icon name="chevron" size={14} /></span></div>} />{!report || completed.length === 0 ? <div className="workspace-card empty-state"><Icon name="chart" size={42} /><h2>还没有可分析的真实会话</h2><p>完成并提交 Listening 或 Reading 后，这里会显示分数趋势、题型正确率和耗时。Writing 只统计字数、时长与完成情况。</p></div> : <><div className="analytics-grid"><section className="workspace-card trend-card"><div className="card-heading"><h2>总体雅思平均分趋势</h2><span className="meta">按提交时间</span></div><MiniTrend points={report.timeTrend} large /></section><section className="workspace-card module-score-card"><h2>各单项平均分</h2><div className="score-rings">{(["listening", "reading", "writing"] as const).map((m) => <div key={m} className={`score-ring ${m}`}><strong>{objective?.[m]?.toFixed(1) ?? "—"}</strong><span>{m === "listening" ? "听力" : m === "reading" ? "阅读" : "写作"}</span><small>{report.moduleCounts[m] ?? 0} 次</small></div>)}<div className="score-ring speaking"><strong>—</strong><span>口语</span><small>未启用</small></div></div></section><section className="workspace-card overall-card"><h2>总体表现</h2><strong>{report.overallAverage?.toFixed(1) ?? "—"}</strong><p>已完成 {completed.length} 次真实会话</p><small>口语未启用，因此不进入总分</small></section></div><div className="analytics-grid lower"><section className="workspace-card accuracy-card"><h2>题型正确率分析</h2>{report.questionTypeAccuracy.length === 0 && <p className="meta">暂无题型数据</p>}{report.questionTypeAccuracy.slice(0, 8).map((row) => <div className="accuracy-row" key={`${row.module}-${row.questionType}`}><span>{row.questionType.replaceAll("_", " ")}</span><i><b style={{ width: `${Math.round(row.accuracy * 100)}%` }} /></i><strong>{Math.round(row.accuracy * 100)}%</strong></div>)}</section><section className="workspace-card time-card"><h2>Listening & Reading 表现</h2><MiniTrend points={report.timeTrend} /></section></div></>}</div>;
}

function History({ sessions, onOpen }: { sessions: SessionSummary[]; onOpen: (id: string) => void }) {
  return <div className="history-page page-stack"><PageHeading title="历史记录" subtitle="查看已完成考试，或恢复安全保存的未完成会话" /><div className="history-list">{sessions.map((s) => <article className="workspace-card history-row" key={s.id}><ModuleIcon module={s.module} size={46} /><div className="history-info"><h3>{s.title || s.examId}</h3><span><b className={`mode-label ${s.mode}`}>{s.mode === "mock" ? "Mock" : "Practice"}</b>{s.module} · {statusLabel(s.status)} · {s.integrity === "clean" ? "完整" : "中断"}</span><small>{formatDate(s.updatedAt)}</small></div><button type="button" className="secondary-button" onClick={() => onOpen(s.id)}>{s.status === "submitted" ? "查看结果" : "继续"}</button></article>)}{sessions.length === 0 && <div className="workspace-card empty-state"><Icon name="history" size={42} /><h2>还没有记录</h2><p>从工作台开始一次练习或模考。</p></div>}</div></div>;
}

function ImportPage({ value, onChange, onImport }: { value: string; onChange: (s: string) => void; onImport: () => void }) {
  return <div className="page-stack"><PageHeading title="导入试卷" subtitle="导入 Schema v1 JSON，不覆盖已有题库与会话" /><section className="workspace-card import-card"><textarea rows={18} value={value} onChange={(e) => onChange(e.target.value)} placeholder="在这里粘贴 Schema v1 Exam JSON…" /><button type="button" className="primary-button" onClick={onImport}>确认导入</button></section></div>;
}

function Settings({ theme, onTheme, onImport }: { theme: UiTheme; onTheme: (t: UiTheme) => void; onImport: () => void }) {
  return <div className="page-stack"><PageHeading title="设置" subtitle="管理外观、试卷导入与软件更新" /><section className="settings-grid"><div className="workspace-card"><Icon name="eye" size={28} /><h2>外观</h2><p className="meta">正式版默认使用参考图的深色桌面主题。</p><div className="button-row"><button type="button" className={theme === "dark" ? "primary-button" : "secondary-button"} onClick={() => onTheme("dark")}>深色</button><button type="button" className={theme === "light" ? "primary-button" : "secondary-button"} onClick={() => onTheme("light")}>浅色</button></div></div><div className="workspace-card"><Icon name="folder" size={28} /><h2>导入试卷</h2><p className="meta">添加符合 Schema v1 的本地题目。</p><button type="button" className="secondary-button" onClick={onImport}>打开导入</button></div><UpdatePanel /></section></div>;
}

function Results({ session, report, exam, onCopy, onHome }: { session: Session; report: ScoreReport | null; exam: Exam | null; onCopy: () => void; onHome: () => void }) {
  return <div className="results-page page-stack"><PageHeading eyebrow={session.mode === "practice" ? "PRACTICE REVIEW" : "MOCK SUBMITTED"} title={exam?.module === "writing" ? "作文已安全保存" : "本次成绩"} subtitle={exam?.title} />{report ? <div className="result-score"><strong>{report.rawCorrect}</strong><span>/ {report.rawTotal}</span><small>Raw score</small></div> : <div className="workspace-card"><p>Writing 不生成客观分数。这里保留字数、时长和完成状态，可复制 Prompt 到外部模型批改。</p></div>}{session.integrity === "interrupted" && <div className="notice-strip warning"><Icon name="info" />本次会话曾中断，因此不会作为完整 Mock 记录。</div>}{report && <div className="review-list">{report.questions.map((q) => <details key={q.questionId} className={`review-item ${q.correct ? "ok" : "bad"}`} open={!q.correct && session.mode === "practice"}><summary>Q{q.number} · {q.correct ? "正确" : "错误"} · 你的答案：{formatAns(q.userAnswer)}</summary><p>可接受答案：{q.acceptedAnswers.join(" / ") || "—"}</p></details>)}</div>}{session.writing && Object.entries(session.writing).map(([id, text]) => <article className="workspace-card writing-result" key={id}><h3>{id}</h3><span>{text.trim() ? text.trim().split(/\s+/).length : 0} words</span><pre>{text}</pre></article>)}<div className="button-row"><button type="button" className="primary-button" onClick={onCopy}>复制批改 Prompt</button><button type="button" className="secondary-button" onClick={onHome}>返回工作台</button></div></div>;
}

function ExamRow({ exam, action, onClick }: { exam: ExamSummary; action: string; onClick: () => void }) {
  return <article className="exam-row"><ModuleIcon module={exam.module} size={44} /><div className="exam-row-copy"><span className="tag">{sourceLabel(exam)}</span><h3>{exam.title}</h3><p>{moduleLabel(exam.module)} · {exam.questionCount} 题</p></div><button type="button" className="secondary-button" onClick={onClick}>{action}</button></article>;
}

function ExamCatalogRow({ exam, mode, action, busy, onClick }: { exam: ExamSummary; mode: "mock" | "practice"; action: string; busy: boolean; onClick: () => void }) {
  return <article className={`catalog-row ${exam.module}`}><ModuleIcon module={exam.module} size={42} /><div className="catalog-title"><h3>{exam.title}</h3><small>{sourceLabel(exam)}</small></div><span><small>模块</small>{moduleLabel(exam.module)}</span><span><small>时长</small>{durationLabel(exam)}</span><span><small>题量</small>{exam.questionCount || "—"} {exam.module === "writing" ? "任务" : "题"}</span><button type="button" className={mode === "mock" ? "strict-button" : "module-button"} disabled={busy} onClick={onClick}>{action}</button></article>;
}

function SessionRow({ session, action, onClick }: { session: SessionSummary; action: string; onClick: () => void }) {
  return <article className="exam-row session-row"><span className="session-icon"><Icon name={session.status === "submitted" ? "check" : "clock"} size={22} /></span><div className="exam-row-copy"><h3>{session.title || session.examId}</h3><p>{session.mode === "mock" ? "模考" : "练习"} · {formatDate(session.updatedAt)}</p></div><button type="button" className="secondary-button" onClick={onClick}>{action}</button></article>;
}

function RecordTable({ sessions }: { sessions: SessionSummary[] }) {
  if (!sessions.length) return <p className="empty-inline">完成一次模考后，记录会显示在这里。</p>;
  return <div className="record-table"><div className="record-head"><span>模考名称</span><span>完成时间</span><span>模块</span><span>状态</span></div>{sessions.map((s) => <div className="record-line" key={s.id}><strong>{s.title || s.examId}</strong><span>{formatDate(s.updatedAt)}</span><span>{moduleLabel(s.module)}</span><b>{statusLabel(s.status)}</b></div>)}</div>;
}

function RecentMockList({ sessions }: { sessions: SessionSummary[] }) {
  if (!sessions.length) return <p className="empty-inline">完成一次模考后，成绩会显示在这里。</p>;
  return <div className="recent-mock-list">{sessions.map((session) => <article key={session.id}><ModuleIcon module={session.module} size={42} /><span><strong>{session.title || session.examId}</strong><small>完成时间：{formatDate(session.updatedAt)}</small></span><b>{statusLabel(session.status)}</b></article>)}</div>;
}

function MiniTrend({ points, large = false }: { points: { score?: number; rawCorrect?: number; rawTotal?: number }[]; large?: boolean }) {
  const values = points.map((p) => p.score ?? (p.rawTotal ? (p.rawCorrect ?? 0) / p.rawTotal * 9 : 0)).filter((v) => Number.isFinite(v));
  if (!values.length) return <div className={`trend-empty ${large ? "large" : ""}`}>完成考试后显示真实趋势</div>;
  const min = Math.min(...values, 0); const max = Math.max(...values, 9); const width = 360; const height = large ? 150 : 86;
  const coords = values.map((v, i) => ({ x: (i / Math.max(1, values.length - 1)) * width, y: height - ((v - min) / Math.max(1, max - min)) * (height - 14) - 7 })); const path = coords.map(({ x, y }) => `${x},${y}`).join(" ");
  return <svg className={`mini-trend ${large ? "large" : ""}`} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="真实成绩趋势"><defs><linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--blue)" stopOpacity=".22"/><stop offset="1" stopColor="var(--blue)" stopOpacity="0"/></linearGradient></defs><polygon points={`0,${height} ${path} ${width},${height}`} fill="url(#trendFill)"/><polyline points={path} fill="none" stroke="var(--blue)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />{coords.map(({ x, y }, i) => <circle key={i} cx={x} cy={y} r="3.5" fill="var(--panel)" stroke="var(--blue)" strokeWidth="2" />)}</svg>;
}

function sourceLabel(exam: ExamSummary) {
  if (exam.source?.kind === "official_sample") return "IELTS Official";
  if (exam.source?.kind === "cambridge_book") return exam.source.title || exam.source.publisher || "Cambridge IELTS";
  if (exam.source?.kind === "imported_document") return exam.source.title || "本地导入";
  return exam.source?.title || "本地题库";
}
function moduleLabel(module: ExamSummary["module"]) { return module[0].toUpperCase() + module.slice(1); }
function durationLabel(exam: ExamSummary) { if (exam.durationMs) return `${Math.round(exam.durationMs / 60000)} 分钟`; if (exam.module === "listening") return "约 30 分钟"; return exam.module === "writing" || exam.module === "reading" ? "60 分钟" : "—"; }
function statusLabel(status: SessionSummary["status"]) { return ({ submitted: "已完成", in_progress: "进行中", interrupted: "已中断", created: "已创建", aborted: "已终止" } as const)[status]; }
function formatDate(value: string) { return value.replace("T", " ").slice(0, 16); }
function formatAns(value: unknown): string { if (value == null || value === "") return "—"; return Array.isArray(value) ? value.join(", ") : String(value); }
