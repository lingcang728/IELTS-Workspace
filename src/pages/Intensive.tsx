import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../components/Ui";
import { PageHeading } from "../components/Shell";
import { assetSrc, loadExam, loadTranscript } from "../lib/api";
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
  const listening = useMemo(() => exams.filter((e) => e.module === "listening"), [exams]);
  const [examId, setExamId] = useState<string>(listening[0]?.id ?? "");
  const [exam, setExam] = useState<Exam | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [src, setSrc] = useState<string>("");
  const [part, setPart] = useState(0);
  const [showText, setShowText] = useState(false);
  const [typed, setTyped] = useState("");
  const [checked, setChecked] = useState(false);
  const [position, setPosition] = useState(0);
  const audio = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (!examId) return;
    let live = true;
    setExam(null); setTranscript(null); setSrc(""); setPart(0); setTyped(""); setChecked(false);
    void (async () => {
      const next = await loadExam(examId).catch(() => null);
      if (!live) return;
      setExam(next);
      if (next?.sections[0]?.audioAsset) {
        setSrc(await assetSrc(next.sections[0].audioAsset).catch(() => ""));
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
  const startMs = section?.audioStartMs ?? 0;
  const durationMs = section?.audioDurationMs ?? 0;

  const lines = useMemo(() => {
    const found = transcript?.sections.find((s) => s.index === part || s.sectionId === section?.id);
    return found?.lines ?? [];
  }, [transcript, part, section?.id]);

  const expected = useMemo(() => lines.map((l) => l.text).join(" "), [lines]);
  const runs = useMemo(() => (checked ? diffWords(expected, typed) : []), [checked, expected, typed]);
  const score = checked ? accuracy(expected, typed) : 0;

  function seekToPart(index: number) {
    setPart(index); setTyped(""); setChecked(false); setShowText(false);
    const target = exam?.sections[index];
    const el = audio.current;
    if (el && target) {
      el.currentTime = (target.audioStartMs ?? 0) / 1000;
      void el.play().catch(() => undefined);
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
          : <p className="meta">这套题没有音频文件。</p>}
        <div className="intensive-progress">
          <span>{clock(Math.max(0, position - startMs))} / {clock(durationMs)}</span>
          <i><b style={{ width: durationMs ? `${Math.min(100, Math.max(0, ((position - startMs) / durationMs) * 100))}%` : "0%" }} /></i>
        </div>
      </section>

      <div className="intensive-grid">
        <section className="workspace-card dictation-card">
          <div className="card-heading"><h2>听写</h2>
            <span className="meta">{checked ? `命中 ${Math.round(score * 100)}%` : "听完这一 Part 再写"}</span></div>
          <textarea rows={10} value={typed} placeholder="把听到的内容写下来，标点和大小写不计入比对"
                    onChange={(e) => { setTyped(e.target.value); setChecked(false); }} />
          <div className="button-row">
            <button type="button" className="primary-button" disabled={!typed.trim() || !expected}
                    onClick={() => setChecked(true)}>比对</button>
            <button type="button" className="secondary-button" onClick={() => { setTyped(""); setChecked(false); }}>清空</button>
          </div>
          {checked && <div className="dictation-diff">{runs.map((run, index) =>
            <span key={index} className={`run ${run.kind}`}>{run.words.join(" ")} </span>)}</div>}
          {checked && <p className="meta">灰底 = 你漏掉的；删除线 = 原文里没有的。</p>}
        </section>

        <section className="workspace-card transcript-card">
          <div className="card-heading"><h2>原文</h2>
            <button type="button" className="link-button" onClick={() => setShowText((v) => !v)}>
              {showText ? "隐藏" : "显示"} <Icon name="eye" size={14} /></button></div>
          {!transcript && <p className="meta">这套题还没有提取到听力原文。</p>}
          {transcript && !showText && <p className="meta">先自己听写，再打开原文对照。</p>}
          {transcript && showText && <div className="transcript-lines">{lines.map((line, index) => {
            const answers = lineAnswers(line);
            return <p key={index} className={answers.length ? "carries-answer" : ""}>
              {line.speaker && <b>{line.speaker}: </b>}
              {line.text}
              {answers.length > 0 && <span className="answer-flag">答案 Q{answers.join(" / Q")}</span>}
            </p>;
          })}
          {lines.length === 0 && <p className="meta">这一 Part 的原文缺失。</p>}</div>}
        </section>
      </div>
    </>}
  </div>;
}
