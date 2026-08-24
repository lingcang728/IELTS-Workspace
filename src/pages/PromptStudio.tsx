import { useEffect, useMemo, useState } from "react";
import { Icon } from "../components/Ui";
import { PageHeading } from "../components/Shell";
import { feedbackDelete, feedbackList, feedbackSave, loadTranscript, mistakeList } from "../lib/api";
import {
  explainPrompt, listeningPrompt, speakingPrompt, TEMPLATES, vocabPrompt, writingPrompt,
} from "../lib/promptStudio";
import { formatDate } from "../lib/format";
import type { Mistake, PromptTemplate, SavedFeedback, VocabCard } from "../lib/types";

const SPEAKING_TOPICS = [
  "Hometown and where you live now",
  "Work or studies",
  "Describe a skill you would like to learn",
  "Technology and daily life",
  "Environment and city planning",
];

export function PromptStudio({ vocab }: { vocab: VocabCard[] }) {
  const [template, setTemplate] = useState<PromptTemplate>("explain");
  const [mistakes, setMistakes] = useState<Mistake[]>([]);
  const [saved, setSaved] = useState<SavedFeedback[]>([]);
  const [taskTitle, setTaskTitle] = useState("Writing Task 2");
  const [taskPrompt, setTaskPrompt] = useState("");
  const [essay, setEssay] = useState("");
  const [topic, setTopic] = useState(SPEAKING_TOPICS[0]);
  const [part, setPart] = useState<1 | 2 | 3>(2);
  const [listeningExam, setListeningExam] = useState("");
  const [prompt, setPrompt] = useState("");
  const [reply, setReply] = useState("");
  const [toast, setToast] = useState("");

  async function reload() {
    const [m, f] = await Promise.all([
      mistakeList().catch(() => []),
      feedbackList().catch(() => []),
    ]);
    setMistakes(m.filter((row) => row.status === "open"));
    setSaved(f);
  }
  useEffect(() => { void reload(); }, []);

  const listeningExams = useMemo(() => {
    const names = new Map<string, string>();
    for (const row of mistakes) {
      if (row.module === "listening") names.set(row.examId, row.examTitle || row.examId);
    }
    return [...names.entries()];
  }, [mistakes]);

  useEffect(() => {
    if (!listeningExam && listeningExams.length) setListeningExam(listeningExams[0][0]);
  }, [listeningExams, listeningExam]);

  async function build() {
    if (template === "writing") {
      setPrompt(writingPrompt(taskTitle, taskPrompt, essay));
    } else if (template === "explain") {
      setPrompt(explainPrompt(mistakes.slice(0, 12)));
    } else if (template === "speaking") {
      setPrompt(speakingPrompt(topic, part));
    } else {
      const rows = mistakes.filter((row) => row.examId === listeningExam);
      const transcript = listeningExam ? await loadTranscript(listeningExam).catch(() => null) : null;
      const title = listeningExams.find(([id]) => id === listeningExam)?.[1] ?? listeningExam;
      setPrompt(listeningPrompt(title, rows, transcript));
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt);
      setToast("已复制，粘贴到外部模型即可");
    } catch { setToast("复制失败，请手动选中"); }
    window.setTimeout(() => setToast(""), 2200);
  }

  async function archive() {
    if (!prompt.trim() || !reply.trim()) return;
    await feedbackSave({
      template,
      title: template === "writing" ? taskTitle : TEMPLATES.find((t) => t.id === template)?.label,
      examId: template === "listening" ? listeningExam : undefined,
      prompt,
      reply,
    }).catch(() => undefined);
    setReply("");
    setToast("已存入个人语料库");
    window.setTimeout(() => setToast(""), 2200);
    await reload();
  }

  return <div className="page-stack studio-page">
    <PageHeading
      title="Prompt Studio"
      subtitle="本应用不内置 AI。这里把题目、你的作答、答案键和原文出处拼成一份完整 prompt，复制到你惯用的模型，再把回复贴回来存档。" />

    <section className="workspace-card template-picker">
      {TEMPLATES.map((item) => <button
        key={item.id} type="button"
        className={`template-card ${template === item.id ? "active" : ""}`}
        onClick={() => { setTemplate(item.id); setPrompt(""); }}>
        <strong>{item.label}</strong><small>{item.blurb}</small>
      </button>)}
    </section>

    <div className="studio-grid">
      <section className="workspace-card studio-input">
        <div className="card-heading"><h2>输入</h2></div>

        {template === "writing" && <>
          <label className="field"><span>题目标题</span>
            <input value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} /></label>
          <label className="field"><span>题干</span>
            <textarea rows={4} value={taskPrompt} onChange={(e) => setTaskPrompt(e.target.value)}
                      placeholder="把 Writing Task 的题干贴进来" /></label>
          <label className="field"><span>你的作文</span>
            <textarea rows={10} value={essay} onChange={(e) => setEssay(e.target.value)} /></label>
        </>}

        {template === "explain" && (mistakes.length
          ? <p className="meta">将把错题本里最近 {Math.min(12, mistakes.length)} 道待攻克错题（共 {mistakes.length} 道）
              连同原文出处一起拼进 prompt。</p>
          : <p className="meta">错题本还是空的。先完成一次听力或阅读。</p>)}

        {template === "speaking" && <>
          <label className="field"><span>话题</span>
            <input value={topic} onChange={(e) => setTopic(e.target.value)} list="speaking-topics" />
            <datalist id="speaking-topics">{SPEAKING_TOPICS.map((t) => <option key={t} value={t} />)}</datalist>
          </label>
          <div className="field"><span>Part</span>
            <div className="filter-tabs">{([1, 2, 3] as const).map((p) =>
              <button key={p} type="button" className={part === p ? "active" : ""}
                      onClick={() => setPart(p)}>Part {p}</button>)}</div></div>
        </>}

        {template === "listening" && (listeningExams.length
          ? <label className="field"><span>试卷</span>
              <select value={listeningExam} onChange={(e) => setListeningExam(e.target.value)}>
                {listeningExams.map(([id, title]) => <option key={id} value={id}>{title}</option>)}
              </select></label>
          : <p className="meta">还没有听力错题。</p>)}

        <div className="button-row">
          <button type="button" className="primary-button" onClick={() => void build()}>生成 Prompt</button>
          {vocab.length > 0 && <button type="button" className="secondary-button"
            onClick={() => setPrompt(vocabPrompt(vocab.slice(0, 20)))}>改成生词讲解</button>}
        </div>
      </section>

      <section className="workspace-card studio-output">
        <div className="card-heading"><h2>Prompt</h2>
          <button type="button" className="link-button" disabled={!prompt} onClick={() => void copy()}>
            复制 <Icon name="document" size={14} /></button></div>
        <textarea rows={14} value={prompt} onChange={(e) => setPrompt(e.target.value)}
                  placeholder="点「生成 Prompt」后出现在这里，可以再手工改" />
        <div className="card-heading"><h2>把模型的回复贴回来</h2></div>
        <textarea rows={7} value={reply} onChange={(e) => setReply(e.target.value)}
                  placeholder="存档后会进入个人语料库，可随时回看" />
        <div className="button-row">
          <button type="button" className="secondary-button" disabled={!prompt.trim() || !reply.trim()}
                  onClick={() => void archive()}>存档</button>
          {toast && <span className="verdict ok">{toast}</span>}
        </div>
      </section>
    </div>

    {saved.length > 0 && <section className="workspace-card">
      <div className="card-heading"><h2>个人语料库</h2><span className="meta">{saved.length} 条</span></div>
      <div className="feedback-list">{saved.map((row) => <details key={row.id} className="feedback-row">
        <summary>{row.title || row.template} · {formatDate(row.savedAt)}</summary>
        <pre>{row.reply}</pre>
        <button type="button" className="link-button"
                onClick={() => void feedbackDelete(row.id).then(reload)}>删除</button>
      </details>)}</div>
    </section>}
  </div>;
}
