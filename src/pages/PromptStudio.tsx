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

const TEMPLATE_ICONS: Record<PromptTemplate, "pen" | "search" | "volume" | "headphones"> = {
  writing: "pen",
  explain: "search",
  speaking: "volume",
  listening: "headphones",
};

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
      setToast("已复制到剪贴板");
    } catch { setToast("复制失败，请手动全选复制"); }
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
    setToast("已成功存入个人语料库");
    window.setTimeout(() => setToast(""), 2200);
    await reload();
  }

  return <div className="page-stack studio-page">
    <PageHeading
      title="Prompt Studio"
      subtitle="本应用不内置 AI。这里把题目、你的作答、答案键和原文出处拼成一份完整 prompt，复制到你惯用的模型，再把回复贴回来存档。" />

    <section className="workspace-card template-picker">
      {TEMPLATES.map((item) => {
        const iconName = TEMPLATE_ICONS[item.id] || "document";
        return (
          <button
            key={item.id}
            type="button"
            className={`template-card ${template === item.id ? "active" : ""}`}
            onClick={() => { setTemplate(item.id); setPrompt(""); }}
          >
            <div className="template-card-top">
              <span className="template-icon-wrap">
                <Icon name={iconName} size={18} />
              </span>
              {template === item.id && <span className="template-active-pill">当前场景</span>}
            </div>
            <div className="template-card-text">
              <strong>{item.label}</strong>
              <small>{item.blurb}</small>
            </div>
          </button>
        );
      })}
    </section>

    <div className="studio-grid">
      <section className="workspace-card studio-input">
        <div className="card-heading">
          <div className="section-title-group">
            <span className="step-badge">STEP 1</span>
            <h2>材料与输入配置</h2>
          </div>
        </div>

        {template === "writing" && <>
          <label className="field"><span>题目标题</span>
            <input value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} /></label>
          <label className="field"><span>题干要求</span>
            <textarea rows={3} value={taskPrompt} onChange={(e) => setTaskPrompt(e.target.value)}
                      placeholder="把 Writing Task 的官方题干要求贴进来" /></label>
          <label className="field">
            <div className="field-label-row">
              <span>你的作答正文</span>
              <small className="field-hint">已输入 {essay.trim() ? essay.trim().split(/\s+/).length : 0} 词</small>
            </div>
            <textarea rows={8} value={essay} onChange={(e) => setEssay(e.target.value)}
                      placeholder="把完整的作文内容贴在这里……" />
          </label>
        </>}

        {template === "explain" && (mistakes.length ? (
          <div className="studio-info-banner">
            <Icon name="check" size={16} />
            <p>已从错题本捕获最近 <strong>{Math.min(12, mistakes.length)}</strong> 道待攻克题目（共 {mistakes.length} 道），将自动打包题干、可接受答案与原文出处。</p>
          </div>
        ) : (
          <div className="studio-empty-notice">
            <Icon name="info" size={24} />
            <div>
              <h4>错题本当前暂无待攻克题目</h4>
              <p>完成真题练习后错题将自动汇入；也可以切换到上方「作文批改」或「口语陪练」体验 Prompt 生成。</p>
            </div>
          </div>
        ))}

        {template === "speaking" && <>
          <label className="field"><span>口语备选话题</span>
            <input value={topic} onChange={(e) => setTopic(e.target.value)} list="speaking-topics" />
            <datalist id="speaking-topics">{SPEAKING_TOPICS.map((t) => <option key={t} value={t} />)}</datalist>
          </label>
          <div className="field"><span>考试 Part 阶段</span>
            <div className="filter-tabs">{([1, 2, 3] as const).map((p) =>
              <button key={p} type="button" className={part === p ? "active" : ""}
                      onClick={() => setPart(p)}>Part {p}</button>)}</div></div>
        </>}

        {template === "listening" && (listeningExams.length ? (
          <label className="field"><span>选择包含错题的听力试卷</span>
            <select value={listeningExam} onChange={(e) => setListeningExam(e.target.value)}>
              {listeningExams.map(([id, title]) => <option key={id} value={id}>{title}</option>)}
            </select></label>
        ) : (
          <div className="studio-empty-notice">
            <Icon name="headphones" size={24} />
            <div>
              <h4>暂无听力错题记录</h4>
              <p>完成听力模考或练习后产生的错题与原文定位会自动汇总于此，生成精细复盘提示词。</p>
            </div>
          </div>
        ))}

        <div className="button-row studio-action-row">
          <button type="button" className="primary-button build-prompt-btn" onClick={() => void build()}>
            <Icon name="rotate" size={14} /> 生成完整 Prompt
          </button>
          {vocab.length > 0 && <button type="button" className="secondary-button"
            onClick={() => setPrompt(vocabPrompt(vocab.slice(0, 20)))}>改成生词精讲</button>}
        </div>
      </section>

      <section className="workspace-card studio-output">
        <div className="studio-stage-section">
          <div className="card-heading">
            <div className="section-title-group">
              <span className="step-badge">STEP 2</span>
              <h2>生成的 Prompt</h2>
            </div>
            <button
              type="button"
              className={`secondary-button copy-prompt-btn ${toast ? "copied" : ""}`}
              disabled={!prompt}
              onClick={() => void copy()}
            >
              <Icon name="document" size={14} /> {toast && toast.includes("复制") ? toast : "一键复制"}
            </button>
          </div>
          <div className="prompt-textarea-wrap">
            <textarea
              rows={9}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="点击左侧「生成完整 Prompt」后，装配好的考官提示词将出现在此，可直接复制或二次调整"
            />
          </div>
        </div>

        <div className="studio-stage-section reply-stage">
          <div className="card-heading">
            <div className="section-title-group">
              <span className="step-badge">STEP 3</span>
              <h2>将模型回复贴回存档</h2>
            </div>
            <button
              type="button"
              className="primary-button archive-btn"
              disabled={!prompt.trim() || !reply.trim()}
              onClick={() => void archive()}
            >
              <Icon name="bookmark" size={14} /> 存入语料库
            </button>
          </div>
          <div className="reply-textarea-wrap">
            <textarea
              rows={6}
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              placeholder="把外部大模型（ChatGPT / Claude / Gemini 等）返回的批改点评或逐题讲解贴回此处，点击右上角存入语料库"
            />
          </div>
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
