import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../components/Ui";
import { PageHeading } from "../components/Shell";
import { loadExam, loadTranscript } from "../lib/api";
import { audioPlaybackSource, listeningReady, localMediaSrc, type PlaybackSource } from "../lib/audio";
import { accuracy, diffWords } from "../lib/dictation";
import type { Exam, ExamSummary, Transcript, TranscriptLine } from "../lib/types";

/** Answer numbers on a transcript line; the field is a list or a stringified list. */
export function lineAnswers(line: TranscriptLine): number[] {
  const raw = line.answers;
  if (Array.isArray(raw)) return raw.map(Number).filter(Number.isFinite);
  if (typeof raw === "string") {
    return [...raw.matchAll(/\d+/g)].map((match) => Number(match[0]));
  }
  return [];
}

function clock(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function Intensive({ exams }: { exams: ExamSummary[] }) {
  // Only papers that actually have a transcript: without one there is nothing
  // to dictate against, and an entry that opens blank is worse than no entry.
  const listening = useMemo(
    () => exams.filter((e) => e.module === "listening" && e.hasTranscript !== false),
    [exams],
  );
  const [examId, setExamId] = useState<string>(listening[0]?.id ?? "");
  const [exam, setExam] = useState<Exam | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [src, setSrc] = useState<string>("");
  const [part, setPart] = useState(0);
  const [showText, setShowText] = useState(false);
  const [typed, setTyped] = useState("");
  const [checked, setChecked] = useState(false);
  const [position, setPosition] = useState(0);
  const [play, setPlay] = useState<PlaybackSource | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    return () => {
      const el = audio.current;
      if (!el) return;
      el.pause();
      el.removeAttribute("src");
      el.load();
    };
  }, []);

  useEffect(() => {
    if (!examId) return;
    audio.current?.pause();
    let live = true;
    setExam(null); setTranscript(null); setSrc(""); setPlay(null); setPart(0); setTyped(""); setChecked(false);
    void (async () => {
      const next = await loadExam(examId).catch(() => null);
      if (!live) return;
      setExam(next);
      try {
        const nextPlay = await audioPlaybackSource(examId);
        setPlay(nextPlay);
        if (nextPlay.tracks[0]) setSrc(localMediaSrc(nextPlay.tracks[0].path));
      } catch {
        setSrc("");
      }
      setTranscript(await loadTranscript(examId).catch(() => null));
    })();
    return () => { live = false; };
  }, [examId]);

  const section = exam?.sections[part];
  // Part boundaries come from the concatenated MP3's per-part durations, which
  // `30_part_offsets.py` measured with ffprobe. No audio alignment is needed to
  // jump to a part — only to a sentence, which is why sentence-level seeking is
  // deliberately not offered here.
  const startMs = play?.mode === "parts" ? 0 : (section?.audioStartMs ?? play?.partStartsMs[part] ?? 0);
  const durationMs = play?.mode === "parts"
    ? (play.tracks[part]?.durationMs ?? 0)
    : (section?.audioDurationMs ?? 0);

  const lines = useMemo(() => {
    const found = transcript?.sections.find((s) => s.index === part || s.sectionId === section?.id);
    return found?.lines ?? [];
  }, [transcript, part, section?.id]);

  const expected = useMemo(() => lines.map((l) => l.text).join(" "), [lines]);
  const runs = useMemo(() => (checked ? diffWords(expected, typed) : []), [checked, expected, typed]);
  const score = checked ? accuracy(expected, typed) : 0;

  function seekToPart(index: number) {
    setPart(index); setTyped(""); setChecked(false); setShowText(false);
    const el = audio.current;
    if (play?.mode === "parts" && play.tracks[index]) {
      setSrc(localMediaSrc(play.tracks[index].path));
      window.setTimeout(() => { void audio.current?.play().catch(() => undefined); }, 40);
      return;
    }
    const target = exam?.sections[index];
    if (el && target) {
      el.currentTime = (target.audioStartMs ?? play?.partStartsMs[index] ?? 0) / 1000;
      void el.play().catch(() => undefined);
    }
  }

  const wordCount = useMemo(() => {
    const trimmed = typed.trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
  }, [typed]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      if (typed.trim() && expected) {
        e.preventDefault();
        setChecked(true);
      }
    }
  }

  return <div className="page-stack intensive-page">
    <PageHeading
      title="精听"
      subtitle="按 Part 跳转 + 逐句跟读 + 听写比对。答案出现在原文哪一句，复盘时直接标出来。"
      aside={<label className="select-field"><span className="sr-only">试卷</span>
        <select value={examId} onChange={(e) => setExamId(e.target.value)}>
          {listening.map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}
        </select></label>} />

    {listening.length === 0 && <div className="workspace-card empty-state">
      <Icon name="headphones" size={42} /><h2>没有可用的听力试卷</h2></div>}

    {exam && <>
      <section className="workspace-card intensive-player">
        <div className="part-tabs">{exam.sections.map((s, index) =>
          <button key={s.id} type="button" className={index === part ? "active" : ""}
                  onClick={() => seekToPart(index)}>
            {s.title || `Part ${index + 1}`}
            <small>{clock(s.audioStartMs ?? 0)}</small>
          </button>)}</div>
        {src
          ? <audio ref={audio} src={src} controls preload="metadata"
                   onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime * 1000)} />
          : <p className="meta">{listeningReady(listening.find((e) => e.id === examId)?.audioStatus) ? "音频正在加载。" : "这套题还没有添加音频。请到听力资源中心导入后再精听。"}</p>}
        <div className="intensive-progress">
          <span>{clock(Math.max(0, position - startMs))} / {clock(durationMs)}</span>
          <i><b style={{ width: durationMs ? `${Math.min(100, Math.max(0, ((position - startMs) / durationMs) * 100))}%` : "0%" }} /></i>
        </div>
      </section>

      <div className="intensive-grid">
        <section className="workspace-card dictation-card">
          <div className="card-heading">
            <div className="section-title-group">
              <Icon name="pen" size={16} />
              <h2>听写练习</h2>
            </div>
            <div className="card-header-actions">
              {checked ? (
                <span className="dictation-badge score">
                  准确率 {Math.round(score * 100)}%
                </span>
              ) : (
                <span className="meta">已输入 {wordCount} 词 · Ctrl+Enter 快速比对</span>
              )}
            </div>
          </div>

          <div className="dictation-input-area">
            <textarea
              value={typed}
              placeholder="在此输入听写内容……（大小写与标点自动忽略，听完完整句子或整段后听写，按 Ctrl+Enter 快速检查）"
              onChange={(e) => { setTyped(e.target.value); setChecked(false); }}
              onKeyDown={handleKeyDown}
            />
          </div>

          <div className="dictation-toolbar">
            <div className="button-row">
              <button
                type="button"
                className="primary-button"
                disabled={!typed.trim() || !expected}
                onClick={() => setChecked(true)}
              >
                <Icon name="check" size={14} /> 比对结果
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={!typed}
                onClick={() => { setTyped(""); setChecked(false); }}
              >
                清空
              </button>
            </div>
            <span className="dictation-rule-hint">标点与大小写自动忽略</span>
          </div>

          {checked && (
            <div className="dictation-result-panel">
              <div className="dictation-legend">
                <span className="legend-item"><i className="legend-dot same" /> 匹配正确</span>
                <span className="legend-item"><i className="legend-dot missing" /> 漏写/错误</span>
                <span className="legend-item"><i className="legend-dot extra" /> 多余词</span>
              </div>
              <div className="dictation-diff">
                {runs.map((run, index) => (
                  <span key={index} className={`run ${run.kind}`}>{run.words.join(" ")} </span>
                ))}
              </div>
            </div>
          )}
        </section>

        <section className="workspace-card transcript-card">
          <div className="card-heading">
            <div className="section-title-group">
              <Icon name="document" size={16} />
              <h2>原文与考点对照</h2>
            </div>
            <button
              type="button"
              className={`link-button text-toggle ${showText ? "active" : ""}`}
              onClick={() => setShowText((v) => !v)}
            >
              {showText ? "隐藏原文" : "显示原文"} <Icon name="eye" size={14} />
            </button>
          </div>

          {!transcript && <div className="transcript-empty"><p className="meta">这套题还没有提取到听力原文。</p></div>}

          {transcript && !showText && (
            <div className="transcript-shield">
              <div className="shield-icon-wrap">
                <Icon name="eye" size={28} />
              </div>
              <h3>防剧透模式已开启</h3>
              <p>建议先自主听写，听完当前 Part 后再开启对照，定位考点句与题目出处。</p>
              <button
                type="button"
                className="secondary-button reveal-button"
                onClick={() => setShowText(true)}
              >
                查看听力原文与考点出处
              </button>
            </div>
          )}

          {transcript && showText && (
            <div className="transcript-lines">
              {lines.map((line, index) => {
                const answers = lineAnswers(line);
                return (
                  <p key={index} className={answers.length ? "carries-answer" : ""}>
                    {line.speaker && <b>{line.speaker}: </b>}
                    {line.text}
                    {answers.length > 0 && (
                      <span className="answer-flag">
                        <Icon name="target" size={11} /> 考点 Q{answers.join(" / Q")}
                      </span>
                    )}
                  </p>
                );
              })}
              {lines.length === 0 && <p className="meta">这一 Part 的原文缺失。</p>}
            </div>
          )}
        </section>
      </div>
    </>}
  </div>;
}
