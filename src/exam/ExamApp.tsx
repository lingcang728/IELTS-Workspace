import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from "react";
import { assetSrc, saveSession, scoreExam, vocabAdd } from "../lib/api";
import { audioPlaybackSource, localMediaSrc, type PlaybackSource } from "../lib/audio";
import { BrandMark, Icon, WindowControls } from "../components/Ui";
import { applyMarks, makeHighlight, rangeToUtf16, recoverHighlight } from "../lib/highlight";
import { toNfc } from "../lib/unicode";
import type {
  Exam,
  HighlightRecord,
  NoteRecord,
  PracticeScheme,
  ScoreReport,
  Session,
} from "../lib/types";
import type { UiTheme } from "../lib/view";
import { allQuestions, sectionForQuestion } from "../lib/types";
import { QuestionGroupView } from "./questions";

interface Props {
  exam: Exam;
  session: Session;
  shellTheme: UiTheme;
  practiceScheme: PracticeScheme;
  onPracticeScheme: (scheme: PracticeScheme) => void;
  onSession: (s: Session) => void;
  onExit: (s: Session, report?: ScoreReport) => void;
}

function fmt(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Parent `session` is a snapshot; remainingMs / audio.positionMs live on the ref between patches. */
function mergeLiveSession(live: Session, incoming: Session): Session {
  if (live === incoming || live.id !== incoming.id) return incoming;
  return {
    ...incoming,
    remainingMs: live.remainingMs,
    audio: incoming.audio?.ended ? incoming.audio : (live.audio ?? incoming.audio),
  };
}

function readVisibleRemainingMs(
  sessionRef: RefObject<Session>,
  audioRef: RefObject<HTMLAudioElement | null>,
  listeningMediaClock: boolean,
  mediaCheckMs: number,
  laterTracksMs: number,
): { ms: number; loading: boolean } {
  const sess = sessionRef.current;
  if (listeningMediaClock && !sess?.audio?.ended) {
    const el = audioRef.current;
    const dur = el?.duration ?? 0;
    const t = el?.currentTime ?? 0;
    if (!(dur > 0)) return { ms: 0, loading: true };
    return { ms: Math.max(0, (dur - t) * 1000 + laterTracksMs + mediaCheckMs), loading: false };
  }
  return { ms: Math.max(0, sess?.remainingMs ?? 0), loading: false };
}

function ExamClock({
  variant,
  wordCount,
  sessionRef,
  audioRef,
  listeningMediaClock,
  mediaCheckMs,
  laterTracksMs,
  timeWarningsMs,
}: {
  variant: "timer" | "writing";
  wordCount?: number;
  sessionRef: MutableRefObject<Session>;
  audioRef: RefObject<HTMLAudioElement | null>;
  listeningMediaClock: boolean;
  mediaCheckMs: number;
  laterTracksMs: number;
  timeWarningsMs: number[];
}) {
  const compute = useCallback(() => {
    const vis = readVisibleRemainingMs(sessionRef, audioRef, listeningMediaClock, mediaCheckMs, laterTracksMs);
    const warn = !vis.loading && timeWarningsMs.some((w) => vis.ms <= w);
    return { ...vis, warn };
  }, [sessionRef, audioRef, listeningMediaClock, mediaCheckMs, laterTracksMs, timeWarningsMs]);

  const [view, setView] = useState(compute);

  useEffect(() => {
    setView(compute());
    const id = window.setInterval(() => setView(compute()), 250);
    return () => window.clearInterval(id);
  }, [compute]);

  if (variant === "writing") {
    return (
      <div className="writing-header-metrics">
        <span><Icon name="clock" size={22} /><small>Time remaining</small><strong>{fmt(view.ms)}</strong></span>
        <span><Icon name="wordcount" size={22} /><small>Word count</small><strong>{wordCount ?? 0}</strong></span>
      </div>
    );
  }

  return (
    <div className="timer-stack">
      <span>Time remaining</span>
      <div className={`timer ${view.warn ? "warn" : ""}`} aria-live="polite">
        {view.loading ? "Loading…" : fmt(view.ms)}
      </div>
    </div>
  );
}

function ListeningPlayer({
  audioRef,
  audioSrc,
  pauseAllowed,
  seekAllowed,
  paused,
  onToggle,
}: {
  audioRef: RefObject<HTMLAudioElement | null>;
  audioSrc: string | null;
  pauseAllowed: boolean;
  seekAllowed: boolean;
  paused: boolean;
  onToggle: () => void;
}) {
  const [audioTime, setAudioTime] = useState(0);
  const [audioDur, setAudioDur] = useState(0);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const sync = () => {
      setAudioTime(el.currentTime);
      setAudioDur(el.duration && Number.isFinite(el.duration) ? el.duration : 0);
    };
    sync();
    el.addEventListener("timeupdate", sync);
    el.addEventListener("loadedmetadata", sync);
    el.addEventListener("durationchange", sync);
    el.addEventListener("seeked", sync);
    return () => {
      el.removeEventListener("timeupdate", sync);
      el.removeEventListener("loadedmetadata", sync);
      el.removeEventListener("durationchange", sync);
      el.removeEventListener("seeked", sync);
    };
  }, [audioRef, audioSrc]);

  return (
    <div className="listening-player">
      <button
        type="button"
        disabled={!pauseAllowed}
        aria-label={pauseAllowed ? "Toggle playback" : "Listening playback locked"}
        onClick={onToggle}
      >
        <span className="player-state"><Icon name={paused ? "play" : "pause"} size={18} /></span>{paused ? "Paused" : "Playing"}
      </button>
      <input
        type="range"
        min={0}
        max={Math.max(1, audioDur)}
        step={0.1}
        value={audioTime}
        aria-label="Seek"
        disabled={!seekAllowed}
        onChange={(e) => {
          const t = Number(e.target.value);
          if (audioRef.current) audioRef.current.currentTime = t;
          setAudioTime(t);
        }}
      />
      <span className="player-time">{fmt(audioTime * 1000)} / {fmt(audioDur * 1000)}</span>
    </div>
  );
}

export function ExamApp({ exam, session, shellTheme, practiceScheme, onPracticeScheme, onSession, onExit }: Props) {
  const questions = useMemo(() => allQuestions(exam), [exam]);
  const [currentId, setCurrentId] = useState(questions[0]?.id ?? "");
  const [writingSectionId, setWritingSectionId] = useState(exam.sections[0]?.id ?? "");
  const [sel, setSel] = useState<{ start: number; end: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [noteOpen, setNoteOpen] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  // The bottom navigator can be collapsed, as in the official runtime.
  const [navOpen, setNavOpen] = useState(true);
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const [audioSrc, setAudioSrc] = useState<string | null>(null);
  const [playback, setPlayback] = useState<PlaybackSource | null>(null);
  const [trackIndex, setTrackIndex] = useState(0);
  const passageRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const nextAudioRef = useRef<HTMLAudioElement>(null);
  const restoredRef = useRef(false);
  const optionsButtonRef = useRef<HTMLButtonElement>(null);
  const optionsPanelRef = useRef<HTMLDivElement>(null);
  const persistTimer = useRef<number | null>(null);
  const lastWarn = useRef<number>(0);
  const submittingRef = useRef(false);
  const [splitPercent, setSplitPercent] = useState<number>(50);
  const isDraggingGutter = useRef(false);
  const sessionRef = useRef(session);
  const parentSessionRef = useRef(session);
  if (parentSessionRef.current !== session) {
    sessionRef.current = mergeLiveSession(sessionRef.current, session);
    parentSessionRef.current = session;
  }

  // Cleanup audio decoders and media buffers when leaving exam runtime
  useEffect(() => {
    const a1 = audioRef.current;
    const a2 = nextAudioRef.current;
    return () => {
      if (a1) {
        a1.pause();
        a1.removeAttribute("src");
        a1.load();
      }
      if (a2) {
        a2.pause();
        a2.removeAttribute("src");
        a2.load();
      }
    };
  }, []);

  const policy = useMemo(() => {
    const p = { ...exam.policy };
    if (session.mode === "practice") {
      p.pauseAllowed = true;
      p.audioSeekAllowed = exam.module !== "listening" ? true : true;
      p.forceSubmit = false;
    } else {
      p.pauseAllowed = false;
      p.audioSeekAllowed = false;
    }
    return p;
  }, [exam.policy, exam.module, session.mode]);

  const current = questions.find((q) => q.id === currentId) ?? questions[0];
  const currentSection = exam.module === "writing"
    ? exam.sections.find((section) => section.id === writingSectionId) ?? exam.sections[0]
    : current ? sectionForQuestion(exam, current.id) : exam.sections[0];
  const [pausedLocal, setPausedLocal] = useState(session.mode === "practice");
  const [optionsOpen, setOptionsOpen] = useState(false);
  const practice = session.mode === "practice";
  const listeningMediaClock = !practice && exam.module === "listening" && exam.policy.endCondition.type === "media_driven";
  const mediaCheckMs = exam.policy.endCondition.type === "media_driven" ? exam.policy.endCondition.checkMsAfterEnd : 0;
  const laterTracksMs = playback?.mode === "parts"
    ? playback.tracks.slice(trackIndex + 1).reduce((sum, track) => sum + track.durationMs, 0)
    : 0;

  useEffect(() => {
    if (!optionsOpen) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      const target = event.target as Node;
      if (optionsButtonRef.current?.contains(target) || optionsPanelRef.current?.contains(target)) return;
      setOptionsOpen(false);
    };
    window.addEventListener("pointerdown", closeOnOutsidePress);
    return () => window.removeEventListener("pointerdown", closeOnOutsidePress);
  }, [optionsOpen]);

  useEffect(() => {
    const sec = currentSection;
    if (!sec) return;
    if (sec.imageAsset) assetSrc(sec.imageAsset).then(setImgSrc).catch(() => setImgSrc(null));
    else setImgSrc(null);
  }, [currentSection?.id]);

  useEffect(() => {
    if (exam.module !== "listening") return;
    let live = true;
    restoredRef.current = false;
    void audioPlaybackSource(exam.id)
      .then((src) => {
        if (!live) return;
        setPlayback(src);
        setTrackIndex(src.mode === "parts" ? Math.min(src.tracks.length - 1, sessionRef.current.audio?.partIndex ?? 0) : 0);
      })
      .catch(() => {
        if (!live) return;
        setPlayback(null);
        setAudioSrc(null);
      });
    return () => {
      live = false;
    };
  }, [exam]);

  useEffect(() => {
    if (!playback) return;
    const track = playback.tracks[trackIndex];
    if (!track) return;
    setAudioSrc(localMediaSrc(track.path));
    const next = playback.mode === "parts" ? playback.tracks[trackIndex + 1] : undefined;
    if (nextAudioRef.current) {
      nextAudioRef.current.src = next ? localMediaSrc(next.path) : "";
      if (next) nextAudioRef.current.load();
    }
  }, [playback, trackIndex]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next: HighlightRecord[] = [];
      for (const hl of session.highlights) {
        const sec = exam.sections.find((s) => s.id === hl.targetId);
        const text = sec?.content?.text ?? "";
        next.push(await recoverHighlight(hl, text));
      }
      if (!cancelled && next.some((h, i) => h.invalid !== session.highlights[i]?.invalid || h.startOffset !== session.highlights[i]?.startOffset)) {
        patch({ highlights: next });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exam.id]);

  const patch = useCallback(
    (partial: Partial<Session>, persist = true) => {
      const next: Session = {
        ...sessionRef.current,
        ...partial,
        updatedAt: new Date().toISOString(),
      };
      sessionRef.current = next;
      onSession(next);
      if (!persist) return;
      if (persistTimer.current) window.clearTimeout(persistTimer.current);
      persistTimer.current = window.setTimeout(() => {
        saveSession(next)
          .then(() => {
            if (sessionRef.current.saveError) {
              onSession({ ...sessionRef.current, saveError: null });
            }
          })
          .catch((err) => {
            onSession({
              ...sessionRef.current,
              saveError: String(err),
            });
            window.setTimeout(() => {
              saveSession(sessionRef.current).catch(() => undefined);
            }, 1500);
          });
      }, 180);
    },
    [onSession],
  );

  const submit = useCallback(
    async (reason: "manual" | "force") => {
      if (submittingRef.current) return;
      submittingRef.current = true;
      const answers: Record<string, unknown> = {};
      for (const [id, a] of Object.entries(sessionRef.current.answers)) {
        answers[id] = a.value;
      }
      let report: ScoreReport | undefined;
      try {
        report = exam.module === "writing" ? undefined : await scoreExam(exam.id, answers);
      } catch (err) {
        submittingRef.current = false;
        patch({ saveError: `评分失败：${String(err)}` }, false);
        setConfirm(false);
        return;
      }
      const next: Session = {
        ...sessionRef.current,
        status: "submitted",
        remainingMs: reason === "force" ? 0 : sessionRef.current.remainingMs,
        saveError: null,
        events: [
          ...sessionRef.current.events,
          {
            t: new Date().toISOString(),
            type: reason === "force" ? "force_submit" : "submit",
            extra: reason,
          },
        ],
      };
      try {
        await saveSession(next);
      } catch (err) {
        submittingRef.current = false;
        onSession({
          ...sessionRef.current,
          remainingMs: next.remainingMs,
          saveError: `提交保存失败，尚未离开考场。${String(err)}`,
        });
        setConfirm(false);
        return;
      }
      onExit(next, report);
    },
    [exam.id, exam.module, onExit, onSession, patch],
  );

  useEffect(() => {
    if (session.status !== "in_progress") return;
    if (pausedLocal && policy.pauseAllowed) return;
    const tickQuiet = (left: number) => {
      sessionRef.current = {
        ...sessionRef.current,
        remainingMs: left,
        updatedAt: new Date().toISOString(),
      };
    };
    if (exam.module === "listening" && exam.policy.endCondition.type === "media_driven") {
      if (session.audio?.ended) {
        const id = window.setInterval(() => {
          const left = sessionRef.current.remainingMs - 250;
          if (left <= 0) {
            window.clearInterval(id);
            patch({ remainingMs: 0 }, false);
            if (policy.forceSubmit) {
              void submit("force");
            }
          } else {
            tickQuiet(left);
          }
        }, 250);
        return () => window.clearInterval(id);
      }
      return;
    }
    const id = window.setInterval(() => {
      const left = sessionRef.current.remainingMs - 250;
      const warnings = exam.policy.timeWarningsMs ?? [];
      for (const w of warnings) {
        if (left <= w && sessionRef.current.remainingMs > w && lastWarn.current !== w) {
          lastWarn.current = w;
          patch({
            remainingMs: left,
            events: [
              ...sessionRef.current.events,
              { t: new Date().toISOString(), type: "warn", extra: String(w) },
            ],
          });
          return;
        }
      }
      if (left <= 0) {
        window.clearInterval(id);
        patch({ remainingMs: 0 }, false);
        if (policy.forceSubmit) {
          void submit("force");
        }
        return;
      }
      tickQuiet(left);
    }, 250);
    const persistId = window.setInterval(() => {
      saveSession(sessionRef.current).catch((err) =>
        patch({ saveError: String(err) }, false),
      );
    }, 5000);
    const onHide = () => {
      saveSession(sessionRef.current).catch((err) =>
        patch({ saveError: String(err) }, false),
      );
    };
    window.addEventListener("blur", onHide);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.clearInterval(id);
      window.clearInterval(persistId);
      window.removeEventListener("blur", onHide);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [exam.module, exam.policy.endCondition, exam.policy.timeWarningsMs, patch, pausedLocal, policy.pauseAllowed, policy.forceSubmit, session.audio?.ended, session.status, submit]);

  function setAnswer(questionId: string, value: string | string[] | null) {
    const q = questions.find((x) => x.id === questionId);
    const currentAnswers = sessionRef.current.answers;
    const answers = {
      ...currentAnswers,
      [questionId]: {
        questionId,
        questionType: q?.type ?? "completion",
        value,
        flagged: currentAnswers[questionId]?.flagged ?? false,
        updatedAt: new Date().toISOString(),
      },
    };
    patch({ answers });
  }

  function toggleFlag() {
    if (!current) return;
    const prev = sessionRef.current.answers[current.id];
    patch({
      answers: {
        ...sessionRef.current.answers,
        [current.id]: {
          questionId: current.id,
          questionType: current.type,
          value: prev?.value ?? null,
          flagged: !prev?.flagged,
          updatedAt: new Date().toISOString(),
        },
      },
    });
  }

  async function addHighlight() {
    const root = passageRef.current;
    if (!root || !currentSection?.content) return;
    const r = sel ?? rangeToUtf16(root);
    if (!r) return;
    const hl = await makeHighlight({
      targetId: currentSection.id,
      sourceText: currentSection.content.text,
      startUtf16: r.start,
      endUtf16: r.end,
    });
    patch({ highlights: [...session.highlights, hl] });
    setMenu(null);
    setSel(null);
    window.getSelection()?.removeAllRanges();
  }

  async function addNote() {
    await addHighlight();
    const last = sessionRef.current.highlights.at(-1);
    if (!last || !currentSection) return;
    const note: NoteRecord = {
      id: `n-${Date.now()}`,
      attach: "highlight",
      targetId: currentSection.id,
      highlightId: last.id,
      body: "",
      updatedAt: new Date().toISOString(),
    };
    patch({ notes: [...sessionRef.current.notes, note] });
    setNoteOpen(note.id);
  }

  /**
   * Selection -> vocabulary card.
   *
   * `makeHighlight` already computes the excerpt and the text either side of
   * it, which is exactly the card's front: the word in the sentence it was met
   * in. So capturing a word costs nothing extra and never produces a bare
   * headword with no context.
   */
  async function addToVocab() {
    const root = passageRef.current;
    if (!root || !currentSection?.content) return;
    const r = sel ?? rangeToUtf16(root);
    if (!r) return;
    const hl = await makeHighlight({
      targetId: currentSection.id,
      sourceText: currentSection.content.text,
      startUtf16: r.start,
      endUtf16: r.end,
    });
    const term = hl.excerpt.trim();
    if (!term || term.length > 40) { setMenu(null); return; }
    const sentence = `${hl.contextBefore}${hl.excerpt}${hl.contextAfter}`.replace(/\s+/g, " ").trim();
    await vocabAdd({
      term,
      sighting: {
        examId: exam.id,
        examTitle: exam.title,
        sentence,
        start: hl.contextBefore.replace(/\s+/g, " ").length,
        end: hl.contextBefore.replace(/\s+/g, " ").length + term.length,
        source: "exam",
      },
    }).catch(() => undefined);
    setMenu(null);
    setSel(null);
    window.getSelection()?.removeAllRanges();
  }

  function deleteHighlight() {
    let targetHlId: string | null = null;
    if (menu) {
      const mark = (document.elementFromPoint(menu.x, menu.y) as HTMLElement | null)?.closest("mark");
      targetHlId = mark?.getAttribute("data-hl") ?? null;
    }
    if (!targetHlId && sel && currentSection) {
      const overlapped = session.highlights.find(
        (h) =>
          h.targetId === currentSection.id &&
          !h.invalid &&
          Math.max(h.startOffset, sel.start) < Math.min(h.endOffset, sel.end),
      );
      if (overlapped) targetHlId = overlapped.id;
    }
    if (!targetHlId) {
      const activeMark = window.getSelection()?.anchorNode?.parentElement?.closest("mark");
      targetHlId = activeMark?.getAttribute("data-hl") ?? null;
    }
    if (!targetHlId) return;
    patch({
      highlights: session.highlights.filter((h) => h.id !== targetHlId),
      notes: session.notes.filter((n) => n.highlightId !== targetHlId),
    });
    setMenu(null);
  }

  const onGutterMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingGutter.current = true;
    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!isDraggingGutter.current) return;
      const body = document.querySelector(".exam-body") as HTMLElement | null;
      if (!body) return;
      const rect = body.getBoundingClientRect();
      const pct = ((moveEvent.clientX - rect.left) / rect.width) * 100;
      setSplitPercent(Math.min(75, Math.max(25, pct)));
    };
    const onMouseUp = () => {
      isDraggingGutter.current = false;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, []);

  const navIndex = Math.max(0, questions.findIndex((q) => q.id === currentId));

  const sectionHighlights = useMemo(() => {
    return session.highlights.filter((h) => h.targetId === currentSection?.id);
  }, [session.highlights, currentSection?.id]);

  const passageHtml = useMemo(() => {
    return currentSection?.content
      ? applyMarks(toNfc(currentSection.content.text), sectionHighlights)
      : "";
  }, [currentSection?.content, sectionHighlights]);

  const values = useMemo(() => {
    const res: Record<string, string | string[] | null> = {};
    for (const [k, v] of Object.entries(session.answers)) res[k] = v.value;
    return res;
  }, [session.answers]);

  function go(id: string) {
    setCurrentId(id);
    const sec = sectionForQuestion(exam, id);
    patch({
      events: [
        ...sessionRef.current.events,
        {
          t: new Date().toISOString(),
          type: "nav",
          questionId: id,
          sectionId: sec?.id,
        },
      ],
    });
    requestAnimationFrame(() => {
      document.querySelector(`[data-qid="${id}"]`)?.scrollIntoView({ block: "center" });
    });
  }

  const fontScale = session.fontScale ?? 1;
  const moduleLabel = exam.module === "reading" ? "Reading" : exam.module === "listening" ? "Listening" : "Writing";
  const writingWordCount = (session.writing?.[currentSection?.id ?? ""] ?? "").trim().split(/\s+/).filter(Boolean).length;
  const examScheme = practice
    ? (practiceScheme === "dark" || (practiceScheme === "follow_shell" && shellTheme === "dark") ? "practice_dark" : "default")
    : (session.colorScheme ?? "default");

  return (
    <div
      className={`exam ${practice ? "practice" : "mock"}`}
      data-theme="exam"
      data-scheme={examScheme}
      style={{ ["--font-scale" as string]: String(fontScale) }}
    >
      <div className="exam-windowbar" data-tauri-drag-region>
        <span data-tauri-drag-region><BrandMark size={17} />IELTS Workspace</span>
        <WindowControls beforeClose={async () => { try { await saveSession(sessionRef.current); } catch { /* close remains available after a failed final save */ } }} />
      </div>
      {session.saveError && (
        <div className="banner-save">
          答案可能尚未安全保存：{session.saveError}
          <button type="button" onClick={() => void saveSession(sessionRef.current).then(() => patch({ saveError: null }, false)).catch((err) => patch({ saveError: String(err) }, false))}>重试保存</button>
          {session.status === "in_progress" && <button type="button" onClick={() => void submit("manual")}>重试提交</button>}
        </div>
      )}
      <header className="exam-header">
        <div className="left">
          <span className={`exam-mode-chip ${practice ? "practice" : "mock"}`}>{practice ? "Practice" : "Mock"}</span>
          <strong>{moduleLabel}</strong>
          <span className="exam-title">{exam.title}</span>
          <span className="section-title">{currentSection?.title}</span>
        </div>
        {exam.module === "writing" ? (
          <ExamClock
            variant="writing"
            wordCount={writingWordCount}
            sessionRef={sessionRef}
            audioRef={audioRef}
            listeningMediaClock={false}
            mediaCheckMs={0}
            laterTracksMs={0}
            timeWarningsMs={practice ? [] : (exam.policy.timeWarningsMs ?? [])}
          />
        ) : practice ? (
          <div className="practice-clock"><span>Flexible session</span><strong>No forced submit</strong></div>
        ) : (
          <ExamClock
            variant="timer"
            sessionRef={sessionRef}
            audioRef={audioRef}
            listeningMediaClock={listeningMediaClock}
            mediaCheckMs={mediaCheckMs}
            laterTracksMs={laterTracksMs}
            timeWarningsMs={exam.policy.timeWarningsMs ?? []}
          />
        )}
        <div className="right toolbar">
          {exam.module === "listening" && (
            <label className="vol-wrap">
              <Icon name="volume" size={16} /> Volume
              <input
                className="vol"
                type="range"
                min={0}
                max={1}
                step={0.01}
                defaultValue={1}
                onChange={(e) => {
                  if (audioRef.current) audioRef.current.volume = Number(e.target.value);
                }}
                aria-label="Volume"
              />
            </label>
          )}
          {policy.pauseAllowed && (
            <button
              type="button"
              onClick={() => {
                setPausedLocal((p) => {
                  const n = !p;
                  if (audioRef.current) {
                    if (n) audioRef.current.pause();
                    else void audioRef.current.play();
                  }
                  return n;
                });
              }}
            >
              <Icon name={pausedLocal ? "play" : "pause"} size={15} />{pausedLocal ? "Resume" : "Pause"}
            </button>
          )}
          <button ref={optionsButtonRef} type="button" aria-expanded={optionsOpen} onClick={() => setOptionsOpen((o) => !o)}>
            <Icon name="contrast" size={16} /> Display
          </button>
          <button type="button" onClick={() => setConfirm(true)}>
            {practice ? "Finish practice" : "Submit test"}
          </button>
        </div>
        {optionsOpen && (
          <div ref={optionsPanelRef} className="options-pop">
            <div className="text-size-heading"><p>Text size</p><output>{Math.round(fontScale * 100)}%</output></div>
            <label className="text-size-slider"><span>A</span><input type="range" min={0.85} max={1.4} step={0.05} value={fontScale} aria-label="Text size" onChange={(event) => patch({ fontScale: Number(event.target.value) })} /><strong>A</strong></label>
            {practice ? (
              <>
                <p className="text-size-heading">Practice appearance</p>
                <div className="row">
                  {([["follow_shell", "Follow workspace"], ["light", "Light"], ["dark", "Dark"]] as const).map(([value, label]) => (
                    <button key={value} type="button" onClick={() => onPracticeScheme(value)}>
                      {label}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <p className="text-size-heading">Colour settings</p>
                <div className="row">
                  {(["default", "high_contrast", "cream"] as const).map((s) => (
                    <button key={s} type="button" onClick={() => patch({ colorScheme: s })}>
                      {s === "default" ? "Default" : s === "high_contrast" ? "Yellow on black" : "Black on cream"}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </header>

      <div className="exam-section-tabs">
        {exam.sections.map((section) => {
          const firstQuestion = section.questionGroups.flatMap((g) => g.questions)[0];
          const active = currentSection?.id === section.id;
          return <button key={section.id} type="button" className={active ? "active" : ""} onClick={() => firstQuestion ? go(firstQuestion.id) : setWritingSectionId(section.id)}>{section.title}</button>;
        })}
      </div>

      <div className="exam-mid">
      {exam.module === "listening" && (
        <ListeningPlayer
          audioRef={audioRef}
          audioSrc={audioSrc}
          pauseAllowed={policy.pauseAllowed}
          seekAllowed={policy.audioSeekAllowed}
          paused={pausedLocal}
          onToggle={() => {
            const el = audioRef.current;
            if (!el) return;
            if (el.paused) {
              void el.play();
              setPausedLocal(false);
            } else {
              el.pause();
              setPausedLocal(true);
            }
          }}
        />
      )}

      <div
        className={`exam-body ${exam.module}`}
        style={exam.module !== "listening" ? { gridTemplateColumns: `${splitPercent}% 6px 1fr` } : undefined}
      >
        {exam.module !== "listening" && (
          <>
            <div
              className="pane"
              onMouseUp={() => {
                const r = passageRef.current ? rangeToUtf16(passageRef.current) : null;
                setSel(r);
              }}
            >
              {imgSrc && (
                <p>
                  <img src={imgSrc} alt="" style={{ maxWidth: "100%" }} />
                </p>
              )}
              {exam.module === "writing" ? (
                <div className="passage">
                  <h4>{currentSection?.title}</h4>
                  <div style={{ whiteSpace: "pre-wrap" }}>{currentSection?.content?.text}</div>
                </div>
              ) : (
                <div
                  className="passage"
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ x: e.clientX, y: e.clientY });
                  }}
                >
                  {/*
                    The heading is deliberately OUTSIDE `passageRef`. Offsets are
                    measured by walking the ref'd element's text, but they index
                    into `section.content.text`, which has no heading — so a
                    heading inside the ref shifted every highlight by its own
                    length (17 characters for "Reading Passage 1").
                  */}
                  <h4>{currentSection?.title ?? ""}</h4>
                  <div ref={passageRef} dangerouslySetInnerHTML={{ __html: passageHtml }} />
                </div>
              )}
              {exam.module === "reading" && (
                <div className="toolbar" style={{ marginTop: 12 }}>
                  <button type="button" disabled={!sel} onClick={() => void addHighlight()}>
                    Highlight
                  </button>
                  <button type="button" disabled={!sel} onClick={() => void addNote()}>
                    Note
                  </button>
                  <button type="button" onClick={deleteHighlight}>
                    Delete Highlight
                  </button>
                </div>
              )}
            </div>
            <div className="gutter" onMouseDown={onGutterMouseDown} />
          </>
        )}
        <div className="pane">
          {exam.module === "listening" && (
            <>
            <audio
              ref={audioRef}
              src={audioSrc ?? undefined}
              autoPlay={!practice}
              onPlay={() => setPausedLocal(false)}
              onPause={() => {
                if (practice) setPausedLocal(true);
              }}
              onEnded={() => {
                if (playback?.mode === "parts" && trackIndex + 1 < playback.tracks.length) {
                  const next = trackIndex + 1;
                  setTrackIndex(next);
                  patch({
                    audio: { positionMs: 0, partIndex: next, ended: false },
                  }, true);
                  restoredRef.current = true;
                  window.setTimeout(() => { void audioRef.current?.play(); }, 30);
                  return;
                }
                const check =
                  exam.policy.endCondition.type === "media_driven"
                    ? exam.policy.endCondition.checkMsAfterEnd
                    : 120000;
                patch({
                  remainingMs: check,
                  audio: { ...(sessionRef.current.audio ?? { positionMs: 0, partIndex: trackIndex }), ended: true, positionMs: (audioRef.current?.duration ?? 0) * 1000, partIndex: trackIndex },
                  events: [...sessionRef.current.events, { t: new Date().toISOString(), type: "audio_end" }],
                });
              }}
              onLoadedMetadata={(e) => {
                const el = e.currentTarget;
                if (restoredRef.current) return;
                const pos = (sessionRef.current.audio?.positionMs ?? 0) / 1000;
                if (pos > 0.4 && pos < el.duration) {
                  el.currentTime = pos;
                }
                restoredRef.current = true;
              }}
              onTimeUpdate={(e) => {
                const el = e.currentTarget;
                const ms = el.currentTime * 1000;
                const partIndex = trackIndex;
                const prev = sessionRef.current.audio;
                if (!prev || Math.abs((prev.positionMs ?? 0) - ms) > 800 || prev.partIndex !== partIndex) {
                  sessionRef.current = {
                    ...sessionRef.current,
                    audio: { positionMs: ms, partIndex, ended: false },
                  };
                }
                if (policy.audioSeekAllowed) return;
                const locked = sessionRef.current.audio;
                if (locked && el.currentTime + 0.4 < (locked.positionMs ?? 0) / 1000) {
                  el.currentTime = (locked.positionMs ?? 0) / 1000;
                }
              }}
              controls={false}
            />
            {playback?.mode === "parts" && <audio ref={nextAudioRef} preload="auto" hidden />}
            </>
          )}
          {exam.module === "writing" ? (
            <WritingPane exam={exam} session={session} patch={patch} sectionId={currentSection?.id} />
          ) : (
            currentSection?.questionGroups.map((g, index) => (
              <QuestionGroupView
                key={g.id || `${g.questionType}-${g.instruction.slice(0, 24)}`}
                group={g}
                section={currentSection}
                values={values}
                onChange={setAnswer}
                skin={session.mode}
                showInstruction={
                  g.instruction.trim() !==
                  (currentSection.questionGroups[index - 1]?.instruction ?? "").trim()
                }
                showImage={
                  Boolean(g.imageAsset) &&
                  g.imageAsset !== currentSection.questionGroups[index - 1]?.imageAsset
                }
              />
            ))
          )}
       </div>
        </div>
      </div>

      <nav className="exam-nav">
        {exam.module !== "writing" && (
          <div className={`nav-strip ${navOpen ? "" : "collapsed"}`}>
            <button type="button" className="nav-collapse" aria-expanded={navOpen} onClick={() => setNavOpen((open) => !open)}>
              <Icon name="chevron" size={13} className={navOpen ? "" : "flip"} />{navOpen ? "Hide" : "Show"} questions
            </button>
            {navOpen ? (
              <div className="question-strip" role="group" aria-label="Question navigator">
                {questions.map((q) => {
                  const a = session.answers[q.id];
                  const answered = a && a.value !== null && a.value !== "" && !(Array.isArray(a.value) && a.value.length === 0);
                  return <button key={q.id} type="button" aria-current={q.id === currentId ? "true" : undefined} aria-label={`Question ${q.number}${answered ? ", answered" : ""}${a?.flagged ? ", flagged for review" : ""}`} className={`${q.id === currentId ? "current" : ""} ${answered ? "answered" : ""} ${a?.flagged ? "flagged" : ""}`} onClick={() => go(q.id)}>{q.number}</button>;
                })}
              </div>
            ) : <span />}
            <div className="nav-legend"><span className="current-dot" />Current <span className="answered-dot" />Answered <span className="review-dot" />Review</div>
          </div>
        )}
        <div className="exam-nav-row">
        <div className="exam-nav-tools">
          {exam.module !== "writing" && <label className="review-toggle"><input type="checkbox" checked={!!session.answers[currentId]?.flagged} onChange={toggleFlag} /><Icon name="bookmark" size={17} />Review later</label>}
          {exam.module === "reading" && <span className="tool-hint"><Icon name="pen" size={16} />Select text to highlight or add a note</span>}
          {practice && <span className="practice-hint"><Icon name="rotate" size={16} />Pause and revisit any question</span>}
        </div>
        <div className="exam-progress-copy">{exam.module === "writing" ? <>Task <strong>{Math.max(1, exam.sections.findIndex((section) => section.id === currentSection?.id) + 1)}</strong> of {exam.sections.length}</> : <>Question <strong>{current?.number ?? 1}</strong> of {questions.length} · Section <strong>{Math.max(1, exam.sections.findIndex((section) => section.id === currentSection?.id) + 1)}</strong> of {exam.sections.length}</>}</div>
        <div className="nav-arrows">
          <button type="button" className="previous-button" disabled={exam.module === "writing" ? exam.sections.findIndex((section) => section.id === currentSection?.id) <= 0 : navIndex <= 0} onClick={() => exam.module === "writing" ? setWritingSectionId(exam.sections[Math.max(0, exam.sections.findIndex((section) => section.id === currentSection?.id) - 1)]?.id ?? writingSectionId) : go(questions[Math.max(0, navIndex - 1)]?.id)}><Icon name="chevron" className="flip" size={16} />Previous</button>
          <button type="button" className="next-button" disabled={exam.module === "writing" ? exam.sections.findIndex((section) => section.id === currentSection?.id) >= exam.sections.length - 1 : navIndex >= questions.length - 1} onClick={() => exam.module === "writing" ? setWritingSectionId(exam.sections[Math.min(exam.sections.length - 1, exam.sections.findIndex((section) => section.id === currentSection?.id) + 1)]?.id ?? writingSectionId) : go(questions[Math.min(questions.length - 1, navIndex + 1)]?.id)}>Next<Icon name="chevron" size={16} /></button>
          <button type="button" className={practice ? "finish-button" : "submit-button"} onClick={() => setConfirm(true)}>{practice ? "Finish practice" : "Submit test"}</button>
        </div>
        </div>
      </nav>

      {menu && exam.module === "reading" && (
        <div className="ctx-menu" style={{ left: menu.x, top: menu.y }}>
          <button type="button" onClick={() => void addHighlight()}>
            Highlight
          </button>
          <button type="button" onClick={() => void addNote()}>
            Note
          </button>
          <button type="button" onClick={() => void addToVocab()}>
            加入生词本
          </button>
          <button type="button" onClick={deleteHighlight}>
            Delete Highlight
          </button>
        </div>
      )}

      {noteOpen && (
        <NoteEditor
          note={session.notes.find((n) => n.id === noteOpen)}
          onClose={() => setNoteOpen(null)}
          onChange={(body) =>
            patch({
              notes: session.notes.map((n) => (n.id === noteOpen ? { ...n, body, updatedAt: new Date().toISOString() } : n)),
            })
          }
        />
      )}

      {confirm && (
        <div className="confirm">
          <div className="box">
            <span className={`confirm-icon ${practice ? "practice" : "mock"}`}><Icon name={practice ? "check" : "lock"} size={24} /></span>
            <h2>{practice ? "Finish this practice?" : "Submit this mock test?"}</h2>
            <p>{practice ? "Your answers will be saved and the review page will show accepted answers." : "The timer will stop and your answers will be final. You cannot return to this test."}</p>
            <div className="row">
              <button type="button" className="primary" onClick={() => void submit("manual")}>
                {practice ? "Finish and review" : "Yes, submit test"}
              </button>
              <button type="button" className="ghost" onClick={() => setConfirm(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function WritingPane({
  exam,
  session,
  patch,
  sectionId,
}: {
  exam: Exam;
  session: Session;
  patch: (p: Partial<Session>) => void;
  sectionId?: string;
}) {
  const sec = exam.sections.find((s) => s.id === sectionId) ?? exam.sections[0];
  if (!sec) {
    return <div className="instr">暂无写作任务内容</div>;
  }
  const text = session.writing?.[sec.id] ?? "";
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const min = sec.id.includes("task2") || /task 2/i.test(sec.title) ? 250 : 150;
  return (
    <div>
      <div className="instr">{sec.title}. Write at least {min} words. You may answer the tasks in either order.</div>
      <textarea
        className="writing-box"
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        value={text}
        onChange={(e) =>
          patch({ writing: { ...(session.writing ?? {}), [sec.id]: e.target.value } })
        }
      />
      <div className="wordcount">Word count: {words}</div>
    </div>
  );
}

function NoteEditor({
  note,
  onClose,
  onChange,
}: {
  note?: NoteRecord;
  onClose: () => void;
  onChange: (body: string) => void;
}) {
  if (!note) return null;
  return (
    <div className="note-pad" style={{ right: 24, top: 64, position: "fixed" }}>
      <button type="button" onClick={onClose} style={{ float: "right", border: 0, background: "transparent" }}>
        ×
      </button>
      <textarea value={note.body} onChange={(e) => onChange(e.target.value)} placeholder="Notes" />
    </div>
  );
}
