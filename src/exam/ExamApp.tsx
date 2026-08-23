import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { assetSrc, saveSession, scoreExam } from "../lib/api";
import { BrandMark, Icon, WindowControls } from "../components/Ui";
import { applyMarks, makeHighlight, rangeToUtf16, recoverHighlight } from "../lib/highlight";
import { toNfc } from "../lib/unicode";
import type {
  Exam,
  HighlightRecord,
  NoteRecord,
  ScoreReport,
  Session,
} from "../lib/types";
import { allQuestions, sectionForQuestion } from "../lib/types";
import { QuestionGroupView } from "./questions";

interface Props {
  exam: Exam;
  session: Session;
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

export function ExamApp({ exam, session, onSession, onExit }: Props) {
  const questions = useMemo(() => allQuestions(exam), [exam]);
  const [currentId, setCurrentId] = useState(questions[0]?.id ?? "");
  const [writingSectionId, setWritingSectionId] = useState(exam.sections[0]?.id ?? "");
  const [sel, setSel] = useState<{ start: number; end: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [noteOpen, setNoteOpen] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const [audioSrc, setAudioSrc] = useState<string | null>(null);
  const passageRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const optionsButtonRef = useRef<HTMLButtonElement>(null);
  const optionsPanelRef = useRef<HTMLDivElement>(null);
  const persistTimer = useRef<number | null>(null);
  const lastWarn = useRef<number>(0);
  const sessionRef = useRef(session);
  sessionRef.current = session;

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
  const [audioTime, setAudioTime] = useState(0);
  const [audioDur, setAudioDur] = useState(0);
  const practice = session.mode === "practice";
  const mediaClockPending = !practice && exam.module === "listening" && exam.policy.endCondition.type === "media_driven" && !session.audio?.ended;
  const mediaCheckMs = exam.policy.endCondition.type === "media_driven" ? exam.policy.endCondition.checkMsAfterEnd : 0;
  const visibleRemainingMs = mediaClockPending && audioDur > 0
    ? Math.max(0, (audioDur - audioTime) * 1000 + mediaCheckMs)
    : session.remainingMs;

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
    const rel = exam.sections.find((s) => s.audioAsset)?.audioAsset;
    if (rel) assetSrc(rel).then(setAudioSrc).catch(() => setAudioSrc(null));
  }, [exam]);

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
      const answers: Record<string, unknown> = {};
      for (const [id, a] of Object.entries(sessionRef.current.answers)) {
        answers[id] = a.value;
      }
      const report = exam.module === "writing" ? undefined : await scoreExam(exam.id, answers);
      const next: Session = {
        ...sessionRef.current,
        status: "submitted",
        remainingMs: reason === "force" ? 0 : sessionRef.current.remainingMs,
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
      } catch {
        next.saveError = "提交时保存失败，成绩仍已计算。";
      }
      onExit(next, report);
    },
    [exam.id, onExit],
  );

  useEffect(() => {
    if (session.status !== "in_progress") return;
    if (pausedLocal && policy.pauseAllowed) return;
    if (exam.module === "listening" && exam.policy.endCondition.type === "media_driven") {
      if (session.audio?.ended) {
        const id = window.setInterval(() => {
          const left = sessionRef.current.remainingMs - 250;
          if (left <= 0) {
            window.clearInterval(id);
            patch({ remainingMs: 0 }, false);
            void submit("force");
          } else {
            patch({ remainingMs: left }, false);
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
        patch({ remainingMs: 0 }, false);
        void submit("force");
        return;
      }
      patch({ remainingMs: left }, false);
    }, 250);
    const persistId = window.setInterval(() => {
      saveSession(sessionRef.current).catch((err) =>
        patch({ saveError: String(err) }, false),
      );
    }, 8000);
    return () => {
      window.clearInterval(id);
      window.clearInterval(persistId);
    };
  }, [session.status, pausedLocal, policy.pauseAllowed, exam.module, exam.policy, patch, submit, session.audio?.ended]);

  function setAnswer(questionId: string, value: string | string[] | null) {
    const q = questions.find((x) => x.id === questionId);
    const answers = {
      ...session.answers,
      [questionId]: {
        questionId,
        questionType: q?.type ?? "completion",
        value,
        flagged: session.answers[questionId]?.flagged ?? false,
        updatedAt: new Date().toISOString(),
      },
    };
    patch({ answers });
  }

  function toggleFlag() {
    if (!current) return;
    const prev = session.answers[current.id];
    patch({
      answers: {
        ...session.answers,
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

  function deleteHighlight() {
    const root = passageRef.current;
    if (!root) return;
    const mark = (document.elementFromPoint(menu?.x ?? 0, menu?.y ?? 0) as HTMLElement | null)?.closest("mark");
    const id = mark?.getAttribute("data-hl");
    if (!id) return;
    patch({
      highlights: session.highlights.filter((h) => h.id !== id),
      notes: session.notes.filter((n) => n.highlightId !== id),
    });
    setMenu(null);
  }

  const navIndex = Math.max(0, questions.findIndex((q) => q.id === currentId));
  const warn = (exam.policy.timeWarningsMs ?? []).some((w) => session.remainingMs <= w);
  const passageHtml = currentSection?.content
    ? applyMarks(
        toNfc(currentSection.content.text),
        session.highlights.filter((h) => h.targetId === currentSection.id),
      )
    : "";

  const values: Record<string, string | string[] | null> = {};
  for (const [k, v] of Object.entries(session.answers)) values[k] = v.value;

  function go(id: string) {
    setCurrentId(id);
    const sec = sectionForQuestion(exam, id);
    patch({
      events: [
        ...session.events,
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

  return (
    <div
      className={`exam ${practice ? "practice" : "mock"}`}
      data-theme="exam"
      data-scheme={practice ? "default" : (session.colorScheme ?? "default")}
      style={{ ["--font-scale" as string]: String(fontScale) }}
    >
      <div className="exam-windowbar" data-tauri-drag-region>
        <span data-tauri-drag-region><BrandMark size={17} />IELTS Workspace</span>
        <WindowControls beforeClose={async () => { try { await saveSession(sessionRef.current); } catch { /* close remains available after a failed final save */ } }} />
      </div>
      {session.saveError && (
        <div className="banner-save">答案可能尚未安全保存：{session.saveError}。正在重试写入。</div>
      )}
      <header className="exam-header">
        <div className="left">
          <span className={`exam-mode-chip ${practice ? "practice" : "mock"}`}>{practice ? "Practice" : "Mock"}</span>
          <strong>{moduleLabel}</strong>
          <span className="exam-title">{exam.title}</span>
          <span className="section-title">{currentSection?.title}</span>
        </div>
        {exam.module === "writing" ? <div className="writing-header-metrics"><span><Icon name="clock" size={22} /><small>Time remaining</small><strong>{fmt(visibleRemainingMs)}</strong></span><span><Icon name="wordcount" size={22} /><small>Word count</small><strong>{writingWordCount}</strong></span></div> : practice ? <div className="practice-clock"><span>Flexible session</span><strong>No forced submit</strong></div> : <div className="timer-stack"><span>Time remaining</span><div className={`timer ${warn ? "warn" : ""}`} aria-live="polite">{mediaClockPending && audioDur <= 0 ? "Loading…" : fmt(visibleRemainingMs)}</div></div>}
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
            {!practice && (
              <>
                <p style={{ marginTop: 12 }}>Colour settings</p>
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
        <div className="listening-player">
          <button
            type="button"
            disabled={!policy.pauseAllowed}
            aria-label={policy.pauseAllowed ? "Toggle playback" : "Listening playback locked"}
            onClick={() => {
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
          >
            <span className="player-state"><Icon name={pausedLocal ? "play" : "pause"} size={18} /></span>{pausedLocal ? "Paused" : "Playing"}
          </button>
          <input
            type="range"
            min={0}
            max={Math.max(1, audioDur)}
            step={0.1}
            value={audioTime}
            aria-label="Seek"
            disabled={!policy.audioSeekAllowed}
            onChange={(e) => {
              const t = Number(e.target.value);
              if (audioRef.current) audioRef.current.currentTime = t;
              setAudioTime(t);
            }}
          />
          <span className="player-time">{fmt(audioTime * 1000)} / {fmt(audioDur * 1000)}</span>
        </div>
      )}

      <div className={`exam-body ${exam.module}`}>
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
                  ref={passageRef}
                  className="passage"
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ x: e.clientX, y: e.clientY });
                  }}
                  dangerouslySetInnerHTML={{
                    __html: `<h4>${currentSection?.title ?? ""}</h4>${passageHtml}`,
                  }}
                />
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
            <div className="gutter" />
          </>
        )}
        <div className="pane">
          {exam.module === "listening" && (
            <audio
              ref={audioRef}
              src={audioSrc ?? undefined}
              autoPlay={!practice}
              onPlay={() => setPausedLocal(false)}
              onPause={() => {
                if (practice) setPausedLocal(true);
              }}
              onEnded={() => {
                const check =
                  exam.policy.endCondition.type === "media_driven"
                    ? exam.policy.endCondition.checkMsAfterEnd
                    : 120000;
                patch({
                  remainingMs: check,
                  audio: { ...(session.audio ?? { positionMs: 0, partIndex: 0 }), ended: true, positionMs: (audioRef.current?.duration ?? 0) * 1000 },
                  events: [...session.events, { t: new Date().toISOString(), type: "audio_end" }],
                });
              }}
              onLoadedMetadata={(e) => setAudioDur(e.currentTarget.duration || 0)}
              onTimeUpdate={(e) => {
                const el = e.currentTarget;
                setAudioTime(el.currentTime);
                if (policy.audioSeekAllowed) return;
                if (session.audio && el.currentTime + 0.4 < (session.audio.positionMs ?? 0) / 1000) {
                  el.currentTime = (session.audio.positionMs ?? 0) / 1000;
                }
              }}
              controls={false}
            />
          )}
          {exam.module === "writing" ? (
            <WritingPane exam={exam} session={session} patch={patch} sectionId={currentSection?.id} />
          ) : (
            currentSection?.questionGroups.map((g) => (
              <QuestionGroupView
                key={g.id || `${g.questionType}-${g.instruction.slice(0, 24)}`}
                group={g}
                section={currentSection}
                values={values}
                onChange={setAnswer}
                skin={session.mode}
              />
            ))
          )}
       </div>
        </div>
        {exam.module !== "writing" && (
          <aside className="exam-right-nav">
            <h3>Question Navigator</h3>
            <div className="nav-legend"><span className="current-dot" />Current <span className="answered-dot" />Answered <span className="review-dot" />Review</div>
            <div className="right-question-grid">{questions.map((q) => { const a = session.answers[q.id]; const answered = a && a.value !== null && a.value !== "" && !(Array.isArray(a.value) && a.value.length === 0); return <button key={q.id} type="button" className={`${q.id === currentId ? "current" : ""} ${answered ? "answered" : ""} ${a?.flagged ? "flagged" : ""}`} onClick={() => go(q.id)}>{q.number}</button>; })}</div>
            <div className="right-section-progress"><span>Section {Math.max(1, exam.sections.findIndex((s) => s.id === currentSection?.id) + 1)} of {exam.sections.length}</span><i><b style={{ width: `${Math.max(8, ((exam.sections.findIndex((s) => s.id === currentSection?.id) + 1) / exam.sections.length) * 100)}%` }} /></i></div>
          </aside>
        )}
      </div>

      <nav className="exam-nav">
        <div className="exam-nav-tools">
          {exam.module !== "writing" && <label className="review-toggle"><input type="checkbox" checked={!!session.answers[currentId]?.flagged} onChange={toggleFlag} /><Icon name="bookmark" size={17} />Review later</label>}
          {exam.module === "reading" && <span className="tool-hint"><Icon name="pen" size={16} />Select text to highlight or add a note</span>}
          {practice && <span className="practice-hint"><Icon name="rotate" size={16} />Pause and revisit any question</span>}
        </div>
        <div className="exam-progress-copy">{exam.module === "writing" ? <>Task <strong>{Math.max(1, exam.sections.findIndex((section) => section.id === currentSection?.id) + 1)}</strong> of {exam.sections.length}</> : <>Question <strong>{current?.number ?? 1}</strong> of {questions.length}</>}</div>
        <div className="nav-arrows">
          <button type="button" className="previous-button" disabled={exam.module === "writing" ? exam.sections.findIndex((section) => section.id === currentSection?.id) <= 0 : navIndex <= 0} onClick={() => exam.module === "writing" ? setWritingSectionId(exam.sections[Math.max(0, exam.sections.findIndex((section) => section.id === currentSection?.id) - 1)]?.id ?? writingSectionId) : go(questions[Math.max(0, navIndex - 1)]?.id)}><Icon name="chevron" className="flip" size={16} />Previous</button>
          <button type="button" className="next-button" disabled={exam.module === "writing" ? exam.sections.findIndex((section) => section.id === currentSection?.id) >= exam.sections.length - 1 : navIndex >= questions.length - 1} onClick={() => exam.module === "writing" ? setWritingSectionId(exam.sections[Math.min(exam.sections.length - 1, exam.sections.findIndex((section) => section.id === currentSection?.id) + 1)]?.id ?? writingSectionId) : go(questions[Math.min(questions.length - 1, navIndex + 1)]?.id)}>Next<Icon name="chevron" size={16} /></button>
          <button type="button" className={practice ? "finish-button" : "submit-button"} onClick={() => setConfirm(true)}>{practice ? "Finish practice" : "Submit test"}</button>
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
