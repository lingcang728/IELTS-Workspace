import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from "react";
import { assetSrc, saveSession, scoreExam, vocabAdd } from "../lib/api";
import { audioPlaybackSource, localMediaSrc, type PlaybackSource } from "../lib/audio";
import { BrandMark, Icon, WindowControls } from "../components/Ui";
import { applyMarks, makeHighlight, rangeToUtf16, recoverHighlight } from "../lib/highlight";
import { clearCloseFlush, registerCloseFlush } from "../lib/closeFlush";
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
import { unansweredCount } from "../lib/reviewPrompt";
import { clampPlaybackTime, timerWarningState } from "../lib/examRuntime";
import { QuestionGroupView } from "./questions";

interface Props {
  exam: Exam;
  session: Session;
  shellTheme: UiTheme;
  practiceScheme: PracticeScheme;
  onPracticeScheme: (scheme: PracticeScheme) => void;
  onSession: (s: Session) => void;
  onExit: (s: Session, report?: ScoreReport) => void;
  /** Save progress and return to the shell without scoring. */
  onLeave: (s: Session) => void;
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
  audioFailed = false,
}: {
  variant: "timer" | "writing";
  wordCount?: number;
  sessionRef: MutableRefObject<Session>;
  audioRef: RefObject<HTMLAudioElement | null>;
  listeningMediaClock: boolean;
  mediaCheckMs: number;
  laterTracksMs: number;
  timeWarningsMs: number[];
  audioFailed?: boolean;
}) {
  const compute = useCallback(() => {
    const vis = readVisibleRemainingMs(sessionRef, audioRef, listeningMediaClock, mediaCheckMs, laterTracksMs);
    const { warn, flash } = vis.loading
      ? { warn: false, flash: false }
      : timerWarningState(vis.ms, timeWarningsMs);
    return { ...vis, warn, flash };
  }, [sessionRef, audioRef, listeningMediaClock, mediaCheckMs, laterTracksMs, timeWarningsMs]);

  const [view, setView] = useState(compute);
  // Screen readers get a one-shot announcement when a warning threshold is
  // crossed — a live region on the 250ms ticker would narrate non-stop.
  const [warnAnnounce, setWarnAnnounce] = useState("");

  useEffect(() => {
    setView(compute());
    const id = window.setInterval(() => setView(compute()), 250);
    return () => window.clearInterval(id);
  }, [compute]);

  useEffect(() => {
    if (view.warn) setWarnAnnounce(`Warning: ${fmt(view.ms)} remaining`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.warn]);

  if (variant === "writing") {
    return (
      <div className="writing-header-metrics">
        <span><Icon name="clock" size={22} /><small>Time remaining</small><strong className={view.warn ? `warn${view.flash ? " flash" : ""}` : undefined}>{fmt(view.ms)}</strong></span>
        <span><Icon name="wordcount" size={22} /><small>Word count</small><strong>{wordCount ?? 0}</strong></span>
      </div>
    );
  }

  return (
    <div className="timer-stack">
      <span>Time remaining</span>
      <div className={`timer${view.warn ? " warn" : ""}${view.flash ? " flash" : ""}`} aria-live="off">
        {view.loading ? (audioFailed ? "No audio" : "Loading…") : fmt(view.ms)}
      </div>
      <span className="sr-only" role="status">{warnAnnounce}</span>
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

export function ExamApp({ exam, session, shellTheme, practiceScheme, onPracticeScheme, onSession, onExit, onLeave }: Props) {
  const questions = useMemo(() => allQuestions(exam), [exam]);
  const [currentId, setCurrentId] = useState(questions[0]?.id ?? "");
  const [writingSectionId, setWritingSectionId] = useState(exam.sections[0]?.id ?? "");
  const [sel, setSel] = useState<{ start: number; end: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [noteOpen, setNoteOpen] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | "submit" | "leave">(null);
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
  // Autosave merge: the debounce, the 5s tick, blur/visibilitychange and the
  // failure retry can all fire inside one write's flight time. Rather than
  // letting them queue up as separate fsync storms, a trigger that arrives
  // mid-write just marks dirty and the landing write re-saves once.
  const saveInFlight = useRef(false);
  const saveDirty = useRef(false);
  // Bounds the failure retry: one fast retry per failure streak (the 5s tick
  // remains the standing retry), reset when a write lands. Without it a
  // persistently unwritable file would retry every 1.5s forever.
  const saveRetried = useRef(false);
  // Writing starts at the designed 38/62 prompt/answer split; reading at 50/50.
  const [splitPercent, setSplitPercent] = useState<number>(exam.module === "writing" ? 38 : 50);
  const isDraggingGutter = useRef(false);
  const gutterCleanup = useRef<(() => void) | null>(null);
  const audioLockSec = useRef(0);
  const sessionRef = useRef(session);
  const parentSessionRef = useRef(session);
  if (parentSessionRef.current !== session) {
    sessionRef.current = mergeLiveSession(sessionRef.current, session);
    parentSessionRef.current = session;
  }
  // Parent callbacks are inline lambdas in App.tsx — keeping them on refs
  // stops `submit`/`leave` from changing identity on every answer patch, which
  // would rebuild the countdown interval on every keystroke.
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const onLeaveRef = useRef(onLeave);
  onLeaveRef.current = onLeave;
  const ctxMenuRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const dialogPrevFocus = useRef<HTMLElement | null>(null);
  const examToastTimer = useRef<number | null>(null);
  const [examToast, setExamToast] = useState<string | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [volume, setVolume] = useState(() => {
    try {
      const stored = Number(window.localStorage.getItem("ielts.exam.volume"));
      return Number.isFinite(stored) && stored >= 0 && stored <= 1 ? stored : 1;
    } catch {
      return 1;
    }
  });

  // Cleanup audio decoders and media buffers when leaving exam runtime.
  // Read refs inside cleanup so a later-assigned preload element is released.
  useEffect(() => {
    return () => {
      gutterCleanup.current?.();
      if (persistTimer.current) {
        window.clearTimeout(persistTimer.current);
        persistTimer.current = null;
      }
      if (examToastTimer.current) {
        window.clearTimeout(examToastTimer.current);
        examToastTimer.current = null;
      }
      const a1 = audioRef.current;
      const a2 = nextAudioRef.current;
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
      p.audioSeekAllowed = true;
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
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOptionsOpen(false);
    };
    window.addEventListener("pointerdown", closeOnOutsidePress);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsidePress);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [optionsOpen]);

  // Context menu: closes on outside press, Escape or a scroll — it used to
  // only close via its own (mutating) buttons, and a fixed-position menu left
  // behind by a pane scroll ends up pointing at the wrong text.
  useEffect(() => {
    if (!menu) return;
    const onPress = (event: PointerEvent) => {
      if (ctxMenuRef.current?.contains(event.target as Node)) return;
      setMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    const onScroll = () => setMenu(null);
    window.addEventListener("pointerdown", onPress);
    window.addEventListener("keydown", onKey);
    // Capture: scroll events do not bubble up from inner panes.
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("pointerdown", onPress);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [menu]);

  // Confirm dialogs: focus moves into the box on open (so Enter no longer
  // re-triggers the opener), Escape cancels, Tab wraps inside, and closing
  // returns focus to whatever opened it.
  useEffect(() => {
    if (!dialog) return;
    dialogPrevFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.querySelector<HTMLElement>(".primary")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDialog(null);
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const items = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>("button, input, select, textarea, [tabindex]:not([tabindex='-1'])"),
      ).filter((el) => !el.hasAttribute("disabled"));
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        last.focus();
        event.preventDefault();
      } else if (!event.shiftKey && document.activeElement === last) {
        first.focus();
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const prev = dialogPrevFocus.current;
      dialogPrevFocus.current = null;
      prev?.focus();
    };
  }, [dialog]);

  // Keyboard selections (caret browsing, Shift+arrows) never fire mouseup —
  // track selectionchange so Highlight / Note / Save word stay reachable
  // without a mouse. A selection outside the passage clears the pending range.
  useEffect(() => {
    if (exam.module !== "reading") return;
    const onSelect = () => {
      setSel(passageRef.current ? rangeToUtf16(passageRef.current) : null);
    };
    document.addEventListener("selectionchange", onSelect);
    return () => document.removeEventListener("selectionchange", onSelect);
  }, [exam.module]);

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
    setAudioError(null);
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
        setAudioError("No playable audio is bound to this test. Use Leave test to save your answers, then re-import the audio in the Audio centre.");
      });
    return () => {
      live = false;
    };
  }, [exam]);

  useEffect(() => {
    if (!playback) return;
    const track = playback.tracks[trackIndex];
    if (!track) return;
    audioLockSec.current = 0;
    setAudioError(null);
    setAudioSrc(localMediaSrc(track.path));
    const next = playback.mode === "parts" ? playback.tracks[trackIndex + 1] : undefined;
    if (nextAudioRef.current) {
      if (next) {
        nextAudioRef.current.src = localMediaSrc(next.path);
        nextAudioRef.current.load();
      } else {
        // An empty src attribute points at the document itself — drop it.
        nextAudioRef.current.removeAttribute("src");
      }
    }
  }, [playback, trackIndex]);

  // The volume slider survives leaving and re-entering the exam runtime.
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [audioSrc, volume]);

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

  const flushSave = useCallback(() => {
    if (submittingRef.current || sessionRef.current.status === "submitted") return;
    if (saveInFlight.current) {
      // A write is already in flight — it will land, see the dirty flag and
      // re-save the newest snapshot. No second IPC, no second fsync.
      saveDirty.current = true;
      return;
    }
    saveInFlight.current = true;
    saveSession(sessionRef.current)
      .then(() => {
        saveRetried.current = false;
        if (sessionRef.current.saveError) {
          // Write through to the ref, not just the parent snapshot —
          // otherwise the next patch resurrects the stale saveError and
          // the banner flickers on every keystroke.
          const cleared = { ...sessionRef.current, saveError: null };
          sessionRef.current = cleared;
          onSession(cleared);
        }
      })
      .catch((err) => {
        if (submittingRef.current || sessionRef.current.status === "submitted") return;
        const failed = {
          ...sessionRef.current,
          saveError: String(err),
        };
        sessionRef.current = failed;
        onSession(failed);
        if (!saveRetried.current) {
          saveRetried.current = true;
          window.setTimeout(() => {
            if (submittingRef.current || sessionRef.current.status === "submitted") return;
            flushSave();
          }, 1500);
        }
      })
      .finally(() => {
        saveInFlight.current = false;
        if (saveDirty.current) {
          saveDirty.current = false;
          flushSave();
        }
      });
  }, [onSession]);

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
      if (submittingRef.current || next.status === "submitted") return;
      if (persistTimer.current) window.clearTimeout(persistTimer.current);
      persistTimer.current = window.setTimeout(() => {
        flushSave();
      }, 180);
    },
    [onSession, flushSave],
  );

  const submit = useCallback(
    async (reason: "manual" | "force") => {
      if (submittingRef.current) return;
      submittingRef.current = true;
      if (persistTimer.current) {
        window.clearTimeout(persistTimer.current);
        persistTimer.current = null;
      }
      const answers: Record<string, unknown> = {};
      for (const [id, a] of Object.entries(sessionRef.current.answers)) {
        answers[id] = a.value;
      }
      let report: ScoreReport | undefined;
      try {
        report = exam.module === "writing" ? undefined : await scoreExam(exam.id, answers);
      } catch (err) {
        submittingRef.current = false;
        patch({ saveError: `Scoring failed: ${String(err)}` }, false);
        setDialog(null);
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
        sessionRef.current = next;
      } catch (err) {
        submittingRef.current = false;
        const failed = {
          ...sessionRef.current,
          remainingMs: next.remainingMs,
          saveError: `The submission could not be saved — you are still in the exam. ${String(err)}`,
        };
        sessionRef.current = failed;
        onSession(failed);
        setDialog(null);
        return;
      }
      onExitRef.current(next, report);
    },
    [exam.id, exam.module, onSession, patch],
  );

  const leave = useCallback(async () => {
    // submittingRef also guards leave: in practice the Save-and-exit button
    // fires without a dialog, so a fast click on Finish during the save IPC
    // would otherwise run submit and leave concurrently.
    if (submittingRef.current) return;
    submittingRef.current = true;
    if (persistTimer.current) {
      window.clearTimeout(persistTimer.current);
      persistTimer.current = null;
    }
    audioRef.current?.pause();
    const next: Session = {
      ...sessionRef.current,
      status: "in_progress",
      saveError: null,
      events: [
        ...sessionRef.current.events,
        { t: new Date().toISOString(), type: "pause", extra: "leave" },
      ],
    };
    try {
      await saveSession(next);
    } catch (err) {
      submittingRef.current = false;
      const failed = {
        ...sessionRef.current,
        saveError: `Leaving could not be saved — you are still in the exam. ${String(err)}`,
      };
      sessionRef.current = failed;
      onSession(failed);
      setDialog(null);
      return;
    }
    onLeaveRef.current(next);
  }, [onSession]);

  // Wall-clock deadline: `setInterval` only ever fires late, so counting down
  // a fixed 250ms per tick systematically overgrants exam time (and freezes
  // entirely across sleep/suspend). The deadline is taken once per effect run;
  // the ref's remainingMs stays the mutable truth between runs.
  useEffect(() => {
    if (session.status !== "in_progress") return;
    if (pausedLocal && policy.pauseAllowed) return;
    const deadline = Date.now() + sessionRef.current.remainingMs;
    const tickQuiet = (left: number) => {
      sessionRef.current = {
        ...sessionRef.current,
        remainingMs: Math.max(0, left),
        updatedAt: new Date().toISOString(),
      };
    };
    const persistNow = () => {
      flushSave();
    };
    // Persistence is installed even while listening audio is still playing —
    // audio.positionMs only lives on the ref, so without this a crash mid-part
    // rolls playback back to the last answer patch.
    const persistId = window.setInterval(persistNow, 5000);
    window.addEventListener("blur", persistNow);
    document.addEventListener("visibilitychange", persistNow);
    const mediaDriven =
      exam.module === "listening" && exam.policy.endCondition.type === "media_driven";
    // While the audio is playing the media clock (element position) drives the
    // countdown; the wall clock owns fixed-duration papers and the post-audio
    // check window.
    let id: number | undefined;
    if (!mediaDriven || session.audio?.ended) {
      id = window.setInterval(() => {
        const left = deadline - Date.now();
        if (!mediaDriven) {
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
        }
        if (left <= 0) {
          if (id !== undefined) window.clearInterval(id);
          patch({ remainingMs: 0 }, false);
          if (policy.forceSubmit) {
            void submit("force");
          }
          return;
        }
        tickQuiet(left);
      }, 250);
    }
    return () => {
      if (id !== undefined) window.clearInterval(id);
      window.clearInterval(persistId);
      window.removeEventListener("blur", persistNow);
      document.removeEventListener("visibilitychange", persistNow);
    };
  }, [exam.module, exam.policy.endCondition, exam.policy.timeWarningsMs, patch, pausedLocal, policy.pauseAllowed, policy.forceSubmit, session.audio?.ended, session.status, submit, flushSave]);

  const setAnswer = useCallback((questionId: string, value: string | string[] | null) => {
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
  }, [questions, patch]);

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

  // Small in-exam confirmation line — the vocabulary book is not visible from
  // here, so "Save word" without feedback leaves the user guessing.
  function flashExam(message: string) {
    setExamToast(message);
    if (examToastTimer.current) window.clearTimeout(examToastTimer.current);
    examToastTimer.current = window.setTimeout(() => setExamToast(null), 2600);
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
    // Read the ref, not the `session` prop — a patch issued earlier in the
    // same event (e.g. an answer keystroke) may not have flushed to props yet.
    patch({ highlights: [...sessionRef.current.highlights, hl] });
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
    if (!term || term.length > 40) {
      setMenu(null);
      flashExam(term ? "That selection is too long for a vocabulary card (40 characters max)." : "Select a word or phrase first.");
      return;
    }
    const sentence = `${hl.contextBefore}${hl.excerpt}${hl.contextAfter}`.replace(/\s+/g, " ").trim();
    // Offsets must index into the trimmed/collapsed sentence — measuring the
    // untrimmed contextBefore shifts the cloze blank when it carries leading
    // whitespace. Locate the term in the final string instead.
    const termAt = sentence.indexOf(term);
    await vocabAdd({
      term,
      sighting: {
        examId: exam.id,
        examTitle: exam.title,
        sentence,
        start: termAt >= 0 ? termAt : undefined,
        end: termAt >= 0 ? termAt + term.length : undefined,
        source: "exam",
      },
    }).then(
      () => flashExam(`Saved "${term}" to the vocabulary book`),
      (err) => flashExam(`Could not save the word: ${String(err)}`),
    );
    setMenu(null);
    setSel(null);
    window.getSelection()?.removeAllRanges();
  }

  function deleteHighlight() {
    let targetHlId: string | null = null;
    if (menu) {
      // The just-opened context menu is on top at that point, so
      // elementFromPoint would always hit the menu itself — walk the stack.
      const mark = document
        .elementsFromPoint(menu.x, menu.y)
        .map((el) => el.closest("mark"))
        .find(Boolean);
      targetHlId = mark?.getAttribute("data-hl") ?? null;
    }
    if (!targetHlId && sel && currentSection) {
      const overlapped = sessionRef.current.highlights.find(
        (h) =>
          h.targetId === currentSection.id &&
          !h.invalid &&
          Math.max(h.startOffset, sel.start) < Math.min(h.endOffset, sel.end),
      );
      if (overlapped) targetHlId = overlapped.id;
    }
    if (!targetHlId) {
      const activeMark =
        window.getSelection()?.anchorNode?.parentElement?.closest("mark")
        ?? (document.activeElement instanceof HTMLElement ? document.activeElement.closest("mark") : null);
      targetHlId = activeMark?.getAttribute("data-hl") ?? null;
    }
    if (!targetHlId) return;
    const nextNotes = sessionRef.current.notes.filter((n) => n.highlightId !== targetHlId);
    patch({
      highlights: sessionRef.current.highlights.filter((h) => h.id !== targetHlId),
      notes: nextNotes,
    });
    // Close the editor if it was showing a note attached to the deleted mark.
    setNoteOpen((cur) => (cur && nextNotes.every((n) => n.id !== cur) ? null : cur));
    setMenu(null);
  }

  const onGutterMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    gutterCleanup.current?.();
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
      gutterCleanup.current = null;
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    gutterCleanup.current = () => {
      isDraggingGutter.current = false;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      gutterCleanup.current = null;
    };
  }, []);

  const navIndex = Math.max(0, questions.findIndex((q) => q.id === currentId));

  const sectionHighlights = useMemo(() => {
    return session.highlights.filter((h) => h.targetId === currentSection?.id);
  }, [session.highlights, currentSection?.id]);

  const notedIds = useMemo(() => {
    return new Set(
      session.notes.map((n) => n.highlightId).filter((id): id is string => Boolean(id)),
    );
  }, [session.notes]);

  // Recovery marks what it cannot place instead of guessing a span — but the
  // user still needs to hear about it, otherwise their highlights vanish
  // without a trace.
  const lostHighlights = sectionHighlights.filter((h) => h.invalid).length;

  const passageHtml = useMemo(() => {
    return currentSection?.content
      ? applyMarks(toNfc(currentSection.content.text), sectionHighlights, notedIds)
      : "";
  }, [currentSection?.content, sectionHighlights, notedIds]);

  const values = useMemo(() => {
    const res: Record<string, string | string[] | null> = {};
    for (const [k, v] of Object.entries(session.answers)) res[k] = v.value;
    return res;
  }, [session.answers]);

  function go(id: string) {
    setCurrentId(id);
    const sec = sectionForQuestion(exam, id);
    if (sec?.id !== currentSection?.id) {
      // Selection, context menu and the open note are all anchored to the old
      // passage's offsets — keep them and a Highlight click would silently
      // mark the new passage at stale offsets.
      setSel(null);
      setMenu(null);
      setNoteOpen(null);
    }
    patch({
      // Nav events dominate the log; cap the tail so rapid navigation cannot
      // grow the session file without bound.
      events: [
        ...sessionRef.current.events.slice(-999),
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
  // Final save shared by the custom X button and the OS-level close path
  // (app-close-requested → closeFlush). Registers globally so Alt+F4 /
  // taskbar close / logoff get the same flush before the window is destroyed.
  const closeFlush = useCallback(async () => {
    try {
      const snap = sessionRef.current;
      // Record the deliberate exit so a later resume is not misread as
      // a crash interruption (integrity is derived from the last event).
      const closing = snap.status === "in_progress"
        ? { ...snap, events: [...snap.events, { t: new Date().toISOString(), type: "pause" as const, extra: "close" }] }
        : snap;
      await saveSession(closing);
    } catch { /* close remains available after a failed final save */ }
  }, []);
  useEffect(() => {
    registerCloseFlush(closeFlush);
    return clearCloseFlush;
  }, [closeFlush]);

  const writingWordCount = (session.writing?.[currentSection?.id ?? ""] ?? "").trim().split(/\s+/).filter(Boolean).length;
  const unanswered = unansweredCount(exam, session);
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
        <WindowControls beforeClose={closeFlush} locale="en" />
      </div>
      {session.saveError && (
        <div className="banner-save" role="alert">
          Your answers may not be saved yet: {session.saveError}
          <button type="button" onClick={() => flushSave()}>Retry save</button>
          {session.status === "in_progress" && <button type="button" onClick={() => void submit("manual")}>Retry submit</button>}
        </div>
      )}
      {audioError && (
        <div className="banner-save" role="alert">{audioError}</div>
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
            audioFailed={Boolean(audioError)}
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
                value={volume}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setVolume(v);
                  if (audioRef.current) audioRef.current.volume = v;
                  try {
                    window.localStorage.setItem("ielts.exam.volume", String(v));
                  } catch { /* volume persistence is best-effort */ }
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
          <button type="button" className="leave-button" onClick={() => practice ? void leave() : setDialog("leave")}>
            {practice ? "Save and exit" : "Leave test"}
          </button>
          <button type="button" className="finish-action" onClick={() => setDialog("submit")}>
            {practice ? "Finish practice" : "Submit test"}
          </button>
        </div>
        {optionsOpen && (
          <div ref={optionsPanelRef} className="options-pop">
            <div className="text-size-heading"><p>Text size</p><output>{Math.round(fontScale * 100)}%</output></div>
            <label className="text-size-slider"><span>A</span><input type="range" min={1} max={1.4} step={0.05} value={fontScale} aria-label="Text size" onChange={(event) => patch({ fontScale: Number(event.target.value) })} /><strong>A</strong></label>
            {practice ? (
              <>
                <p className="text-size-heading">Practice appearance</p>
                <div className="row">
                  {([["follow_shell", "Follow workspace"], ["light", "Light"], ["dark", "Dark"]] as const).map(([value, label]) => (
                    <button key={value} type="button" className={practiceScheme === value ? "on" : ""} aria-pressed={practiceScheme === value} onClick={() => onPracticeScheme(value)}>
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
                    <button key={s} type="button" className={(session.colorScheme ?? "default") === s ? "on" : ""} aria-pressed={(session.colorScheme ?? "default") === s} onClick={() => patch({ colorScheme: s })}>
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
          return <button key={section.id} type="button" className={active ? "active" : ""} aria-current={active ? "true" : undefined} onClick={() => firstQuestion ? go(firstQuestion.id) : setWritingSectionId(section.id)}>{section.title}</button>;
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
        style={exam.module !== "listening"
          // minmax() keeps the CSS pane floor that a bare percent would drop;
          // the 7px gutter column matches .exam-body in exam.css.
          ? { gridTemplateColumns: `minmax(${exam.module === "writing" ? 320 : 300}px, ${splitPercent}%) 7px minmax(300px, 1fr)` }
          : undefined}
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
                  tabIndex={0}
                  aria-label="Passage text — select to highlight or take a note"
                  onClick={(e) => {
                    // Clicking marked text reopens its note (official
                    // behaviour); marks without a note stay inert.
                    const mark = (e.target as HTMLElement).closest?.("mark[data-hl]");
                    const hlId = mark?.getAttribute("data-hl");
                    const note = hlId
                      ? sessionRef.current.notes.find((n) => n.highlightId === hlId)
                      : undefined;
                    if (note) setNoteOpen(note.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    const mark = (e.target as HTMLElement).closest?.("mark[data-hl]");
                    const hlId = mark?.getAttribute("data-hl");
                    const note = hlId
                      ? sessionRef.current.notes.find((n) => n.highlightId === hlId)
                      : undefined;
                    if (!note) return;
                    e.preventDefault();
                    setNoteOpen(note.id);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    // A keyboard-invoked context menu (Menu key / Shift+F10 on
                    // the focused passage) has no pointer coordinates — anchor
                    // at the selection, falling back to the passage corner.
                    let x = e.clientX;
                    let y = e.clientY;
                    if (!x && !y) {
                      const sel0 = window.getSelection();
                      const rangeRect = sel0 && sel0.rangeCount
                        ? sel0.getRangeAt(0).getBoundingClientRect()
                        : null;
                      const box = rangeRect && (rangeRect.width || rangeRect.height)
                        ? rangeRect
                        : (e.currentTarget as HTMLElement).getBoundingClientRect();
                      x = box.left + 8;
                      y = box.top + 8;
                    }
                    // Clamp inside the viewport so right-clicking near the
                    // right/bottom edge does not push the menu off-screen.
                    setMenu({
                      x: Math.max(8, Math.min(x, window.innerWidth - 170)),
                      y: Math.max(8, Math.min(y, window.innerHeight - 170)),
                    });
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
                  <button type="button" disabled={!sel} title={sel ? undefined : "Select text in the passage first"} onClick={() => void addHighlight()}>
                    Highlight
                  </button>
                  <button type="button" disabled={!sel} title={sel ? undefined : "Select text in the passage first"} onClick={() => void addNote()}>
                    Note
                  </button>
                  <button type="button" disabled={!sel} title={sel ? "Save the selected word or phrase to the vocabulary book" : "Select text in the passage first"} onClick={() => void addToVocab()}>
                    Save word
                  </button>
                  <button type="button" onClick={deleteHighlight} title="Right-click a highlight, or select it first">
                    Delete Highlight
                  </button>
                  {lostHighlights > 0 && (
                    <span className="meta" role="status" style={{ alignSelf: "center" }}>
                      {lostHighlights} highlight{lostHighlights === 1 ? "" : "s"} could not be restored after the text changed
                    </span>
                  )}
                </div>
              )}
            </div>
            <div
              className="gutter"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize panels"
              aria-valuemin={25}
              aria-valuemax={75}
              aria-valuenow={Math.round(splitPercent)}
              aria-valuetext={`${Math.round(splitPercent)} percent passage width`}
              tabIndex={0}
              onMouseDown={onGutterMouseDown}
              onKeyDown={(e) => {
                const step = e.key === "ArrowLeft" ? -3 : e.key === "ArrowRight" ? 3 : 0;
                if (!step) return;
                e.preventDefault();
                setSplitPercent((p) => Math.min(75, Math.max(25, p + step)));
              }}
            />
          </>
        )}
        <div className="pane">
          {exam.module === "listening" && (
            <>
            <audio
              ref={audioRef}
              src={audioSrc ?? undefined}
              autoPlay={!practice && !session.audio?.ended}
              onPlay={() => setPausedLocal(false)}
              onPause={() => {
                if (practice) setPausedLocal(true);
              }}
              onError={() => {
                if (!audioSrc) return;
                setAudioError("The audio file could not be loaded or decoded. Use Leave test to save your answers, then re-import the audio in the Audio centre.");
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
                // Only a media_driven paper converts the remaining time into
                // the check window; a fixed_duration listening paper keeps its
                // own clock running to the original deadline.
                const endPatch: Partial<Session> = {
                  audio: { ...(sessionRef.current.audio ?? { positionMs: 0, partIndex: trackIndex }), ended: true, positionMs: (audioRef.current?.duration ?? 0) * 1000, partIndex: trackIndex },
                  events: [...sessionRef.current.events, { t: new Date().toISOString(), type: "audio_end" }],
                };
                if (exam.policy.endCondition.type === "media_driven") {
                  endPatch.remainingMs = exam.policy.endCondition.checkMsAfterEnd;
                }
                patch(endPatch);
              }}
              onLoadedMetadata={(e) => {
                const el = e.currentTarget;
                if (restoredRef.current) return;
                if (sessionRef.current.audio?.ended) {
                  // Single-play rule: a session resumed after the audio already
                  // finished parks at the end — it must not replay from 0.
                  el.currentTime = Number.isFinite(el.duration) ? el.duration : 0;
                  el.pause();
                  setPausedLocal(true);
                  audioLockSec.current = el.currentTime;
                  restoredRef.current = true;
                  return;
                }
                const pos = (sessionRef.current.audio?.positionMs ?? 0) / 1000;
                if (pos > 0.4 && pos < el.duration) {
                  el.currentTime = pos;
                }
                audioLockSec.current = el.currentTime;
                restoredRef.current = true;
              }}
              onTimeUpdate={(e) => {
                const el = e.currentTarget;
                const clamped = clampPlaybackTime(el.currentTime, audioLockSec.current, policy.audioSeekAllowed);
                if (clamped.snapped) {
                  el.currentTime = clamped.time;
                  return;
                }
                audioLockSec.current = clamped.lock;
                const ms = el.currentTime * 1000;
                const partIndex = trackIndex;
                const prev = sessionRef.current.audio;
                if (!prev || Math.abs((prev.positionMs ?? 0) - ms) > 800 || prev.partIndex !== partIndex) {
                  sessionRef.current = {
                    ...sessionRef.current,
                    audio: { positionMs: ms, partIndex, ended: false },
                  };
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
        </div>
        </div>
      </nav>

      {menu && exam.module === "reading" && (
        <div ref={ctxMenuRef} className="ctx-menu" role="menu" style={{ left: menu.x, top: menu.y }}>
          <button type="button" onClick={() => void addHighlight()}>
            Highlight
          </button>
          <button type="button" onClick={() => void addNote()}>
            Note
          </button>
          <button type="button" onClick={() => void addToVocab()}>
            Add to vocabulary
          </button>
          <button type="button" onClick={deleteHighlight}>
            Delete Highlight
          </button>
        </div>
      )}

      {examToast && <div className="exam-toast" role="status">{examToast}</div>}

      {noteOpen && (
        <NoteEditor
          note={session.notes.find((n) => n.id === noteOpen)}
          onClose={() => setNoteOpen(null)}
          onChange={(body) =>
            patch({
              notes: sessionRef.current.notes.map((n) => (n.id === noteOpen ? { ...n, body, updatedAt: new Date().toISOString() } : n)),
            })
          }
        />
      )}

      {dialog === "submit" && (
        <div
          ref={dialogRef}
          className="confirm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-submit-title"
          onClick={(e) => {
            if (e.target === e.currentTarget) setDialog(null);
          }}
        >
          <div className="box">
            <span className={`confirm-icon ${practice ? "practice" : "mock"}`}><Icon name={practice ? "check" : "lock"} size={24} /></span>
            <h2 id="confirm-submit-title">{practice ? "Finish this practice?" : "Submit this mock test?"}</h2>
            <p>{practice ? "Your answers will be saved and the review page will show accepted answers." : "The timer will stop and your answers will be final. You cannot return to this test."}
              {unanswered > 0 ? ` ${unanswered} question${unanswered === 1 ? " is" : "s are"} still unanswered.` : ""}</p>
            <div className="row">
              <button type="button" className="primary" onClick={() => void submit("manual")}>
                {practice ? "Finish and review" : "Yes, submit test"}
              </button>
              <button type="button" className="ghost" onClick={() => setDialog(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      {dialog === "leave" && (
        <div
          ref={dialogRef}
          className="confirm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-leave-title"
          onClick={(e) => {
            if (e.target === e.currentTarget) setDialog(null);
          }}
        >
          <div className="box">
            <span className="confirm-icon mock"><Icon name="info" size={24} /></span>
            <h2 id="confirm-leave-title">Leave this mock test?</h2>
            <p>This is not a submission. Your answers and remaining time will be saved, and you can continue later from Mock.</p>
            <div className="row">
              <button type="button" className="primary" onClick={() => void leave()}>
                Leave and save
              </button>
              <button type="button" className="ghost" onClick={() => setDialog(null)}>
                Stay
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
    return <div className="instr">No writing task is available for this section.</div>;
  }
  const text = session.writing?.[sec.id] ?? "";
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
  // The pad opens next to its marked text (official behaviour), clamped to
  // the viewport and below the header so it can never cover the toolbar.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    const mark = note?.highlightId
      ? document.querySelector(`mark[data-hl="${note.highlightId}"]`)
      : null;
    const rect = mark?.getBoundingClientRect();
    const width = 260;
    setPos(
      rect
        ? {
            left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
            top: Math.max(110, Math.min(rect.bottom + 8, window.innerHeight - 190)),
          }
        : { left: Math.max(8, window.innerWidth - width - 24), top: 110 },
    );
  }, [note?.highlightId]);
  if (!note || !pos) return null;
  return (
    <div className="note-pad" style={{ left: pos.left, top: pos.top }}>
      <button type="button" onClick={onClose} aria-label="Close note" style={{ float: "right", border: 0, background: "transparent" }}>
        ×
      </button>
      <textarea autoFocus value={note.body} onChange={(e) => onChange(e.target.value)} placeholder="Notes" />
    </div>
  );
}
