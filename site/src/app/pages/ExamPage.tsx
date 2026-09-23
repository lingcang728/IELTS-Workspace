/**
 * 考场路由页 — `#/app/exam?exam=<id>&mode=mock|practice&session=<id>`。
 *
 * 职责只有四件：把 query 解析成（试卷, 模式, 会话）、按桌面端 `App.tsx`
 * 的规则新建或恢复 Session、把 Profile 里的练习配色/外壳主题传给考场、
 * 交卷后收录错题并跳复盘页。考试过程本身全在 `../exam/ExamApp`。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  discardSession,
  loadExam,
  loadProfile,
  loadSession,
  mistakeAdd,
  saveProfile,
  saveSession,
} from "../api";
import { navigate, type Route } from "../nav";
import { mistakesFromReport } from "../lib/mistakes";
import type { UiTheme } from "../lib/view";
import { allQuestions } from "../types";
import type {
  Exam,
  ExamMode,
  PracticeScheme,
  Profile,
  ScoreReport,
  Session,
} from "../types";
import { ExamApp } from "../exam/ExamApp";
import { BrandMark } from "../exam/icons";
import "../styles/tokens.css";
import "../styles/exam.css";

type Gate =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "interrupted"; exam: Exam; session: Session }
  | { kind: "ready"; exam: Exam; session: Session };

/** New-attempt session — mirrors `createExamSession` in desktop `App.tsx`:
 *  every question gets an empty AnswerEntry up front and the event log opens
 *  with `start`, so a later resume can tell a clean exit from a crash. */
function buildSession(exam: Exam, mode: ExamMode): Session {
  const now = new Date().toISOString();
  const questions = allQuestions(exam);
  const duration =
    exam.policy.endCondition.type === "fixed_duration"
      ? exam.policy.endCondition.durationMs
      : 0;
  const id =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? `s-${crypto.randomUUID()}`
      : `s-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return {
    schemaVersion: 1,
    id,
    examId: exam.id,
    examRevision: exam.contentRevision,
    examTitle: exam.title,
    module: exam.module,
    mode,
    status: "in_progress",
    integrity: "clean",
    startedAt: now,
    updatedAt: now,
    remainingMs: duration,
    answers: Object.fromEntries(
      questions.map((q) => [
        q.id,
        { questionId: q.id, questionType: q.type, value: null, flagged: false, updatedAt: now },
      ]),
    ),
    highlights: [],
    notes: [],
    events: [
      { t: now, type: "start", sectionId: exam.sections[0]?.id, questionId: questions[0]?.id },
    ],
    audio: exam.module === "listening" ? { positionMs: 0, partIndex: 0 } : undefined,
    writing: {},
    fontScale: 1,
    colorScheme: "default",
    saveError: null,
  };
}

function useNarrowScreen(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.innerWidth < 760,
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 759px)");
    const onChange = () => setNarrow(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return narrow;
}

export default function ExamPage({ route }: { route: Route }) {
  const [gate, setGate] = useState<Gate>({ kind: "loading" });
  const [profile, setProfile] = useState<Profile | null>(null);
  const narrow = useNarrowScreen();

  const examIdQ = route.query.get("exam");
  const sessionIdQ = route.query.get("session");
  const modeQ = route.query.get("mode");
  const initKey = sessionIdQ ? `session:${sessionIdQ}` : `new:${examIdQ ?? ""}:${modeQ ?? ""}`;
  // React StrictMode mounts the effect twice in dev; dedup by key so the
  // same params never create two sessions. The init promise is shared —
  // a remount just re-attaches its own state setter.
  const initRef = useRef<{ key: string; promise: Promise<Gate> } | null>(null);

  useEffect(() => {
    let live = true;

    const init = async (): Promise<Gate> => {
      const prof = await loadProfile().catch(() => null);
      setProfile(prof);
      try {
        if (sessionIdQ) {
          const loaded = await loadSession(sessionIdQ);
          // Legacy sessions may carry the retired "high_contrast" scheme —
          // normalise to "dark" so the runtime never renders black/yellow.
          // (The shared Session type still names the old union; the widened
          // ternary is asserted back through it.)
          const sess: Session = {
            ...loaded,
            colorScheme: (loaded.colorScheme === "high_contrast" ? "dark" : loaded.colorScheme) as Session["colorScheme"],
          };
          const ex = await loadExam(sess.examId);
          if (sess.status === "submitted") {
            navigate("/app/results", { session: sess.id });
            return { kind: "loading" };
          }
          // Content changed under this session — keep it as interrupted
          // rather than resuming against a different answer key.
          if (sess.examRevision && ex.contentRevision && sess.examRevision !== ex.contentRevision) {
            const interrupted: Session = {
              ...sess,
              status: "interrupted",
              integrity: "interrupted",
              updatedAt: new Date().toISOString(),
            };
            await saveSession(interrupted);
            return { kind: "interrupted", exam: ex, session: interrupted };
          }
          // A deliberate Save-and-exit / close writes a trailing "pause"
          // event; anything else means the session was cut off mid-write.
          const cleanExit = sess.events?.at(-1)?.type === "pause";
          const next: Session = {
            ...sess,
            integrity:
              sess.integrity === "interrupted" || !cleanExit ? "interrupted" : "clean",
            status: "in_progress",
            examRevision: ex.contentRevision ?? sess.examRevision,
          };
          await saveSession(next);
          return { kind: "ready", exam: ex, session: next };
        }
        if (!examIdQ) return { kind: "error", message: "缺少试卷参数，请从题库或工作台进入。" };
        const ex = await loadExam(examIdQ);
        const mode: ExamMode =
          modeQ === "mock" || modeQ === "practice"
            ? modeQ
            : (ex.policy.modeDefault ?? "practice");
        const sess = buildSession(ex, mode);
        await saveSession(sess);
        return { kind: "ready", exam: ex, session: sess };
      } catch (err) {
        return { kind: "error", message: String(err) };
      }
    };

    if (!initRef.current || initRef.current.key !== initKey) {
      initRef.current = { key: initKey, promise: init() };
    }
    initRef.current.promise.then((g) => {
      if (live) setGate(g);
    });
    return () => {
      live = false;
    };
  }, [initKey, examIdQ, sessionIdQ, modeQ]);

  // ExamApp patches call this on every keystroke — keep it referentially
  // stable so the runtime's debounced save/clock effects don't rebuild.
  const handleSession = useCallback((s: Session) => {
    setGate((g) => (g.kind === "ready" ? { ...g, session: s } : g));
  }, []);

  const handlePracticeScheme = useCallback((scheme: PracticeScheme) => {
    setProfile((prev) => {
      const next: Profile = { ...(prev ?? {}), practiceScheme: scheme };
      void saveProfile(next).catch(() => undefined);
      return next;
    });
  }, []);

  const shellTheme: UiTheme =
    document.documentElement.dataset.ui === "dark" || document.documentElement.dataset.ui === "light"
      ? document.documentElement.dataset.ui
      : (profile?.theme ?? "light");
  const practiceScheme: PracticeScheme = profile?.practiceScheme ?? "follow_shell";

  const narrowNote = narrow ? (
    <div className="exam-screen-note" role="status">
      推荐使用 ≥11 英寸屏幕以获得完整机考体验
    </div>
  ) : null;

  if (gate.kind !== "ready") {
    return (
      <div className="exam-page">
        {narrowNote}
        <div className="exam" data-theme="exam">
          <div className="exam-gate">
            <div className="gate-box">
              <BrandMark size={48} />
              {gate.kind === "loading" && (
                <>
                  <h1>正在打开试卷…</h1>
                  <p>正在加载试卷与作答记录。</p>
                </>
              )}
              {gate.kind === "error" && (
                <>
                  <h1>无法进入考场</h1>
                  <p>{gate.message}</p>
                  <div className="button-row">
                    <button type="button" className="primary" onClick={() => navigate("/app")}>
                      返回工作台
                    </button>
                  </div>
                </>
              )}
              {gate.kind === "interrupted" && (
                <>
                  <h1>题目内容已更新</h1>
                  <p>
                    这份作答记录已安全保留为中断状态，不能继续作答。可以在历史页查看，
                    或重新开始一套新会话。
                  </p>
                  <div className="button-row">
                    <button
                      type="button"
                      className="primary"
                      onClick={() =>
                        navigate("/app/exam", { exam: gate.exam.id, mode: gate.session.mode })
                      }
                    >
                      开始新会话
                    </button>
                    <button type="button" onClick={() => navigate("/app")}>
                      返回工作台
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="exam-page">
      {narrowNote}
      <ExamApp
        key={gate.session.id}
        exam={gate.exam}
        session={gate.session}
        shellTheme={shellTheme}
        practiceScheme={practiceScheme}
        onPracticeScheme={handlePracticeScheme}
        onSession={handleSession}
        onExit={(s, r?: ScoreReport) => {
          // Collected here rather than inside ExamApp: the runtime stays free
          // of study-tool concerns; entries are keyed by exam+question so a
          // re-do updates the row instead of duplicating it.
          if (r) {
            const entries = mistakesFromReport(gate.exam, r);
            if (entries.length) void mistakeAdd(entries).catch(() => undefined);
          }
          navigate("/app/results", { session: s.id });
        }}
        onLeave={() => {
          // ExamApp.leave() already awaited saveSession before this fires.
          navigate("/app");
        }}
        onDiscard={async (s) => {
          // ExamApp.discard() sets its submitting guard before this fires, so
          // the unmount flush cannot resurrect the deleted record.
          await discardSession(s.id);
          navigate("/app");
        }}
      />
    </div>
  );
}
