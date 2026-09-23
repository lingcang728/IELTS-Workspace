/**
 * 成绩复盘 — web port of the desktop `Results` page, enhanced per WEB-V2:
 * the score is re-computed here (`scoreExam` against the current exam JSON),
 * wrong answers expand to show the accepted answers, the question type, and
 * the sentence in the passage/transcript where the answer lives, plus a
 * "练这个题型" link into the filtered library.
 */
import { useEffect, useRef, useState } from "react";
import type { Route } from "../nav";
import { navigate } from "../nav";
import { loadExam, loadProfile, loadSession, loadTranscript } from "../api";
import { scoreExam } from "../scoring";
import { buildReviewPrompt } from "../lib/reviewPrompt";
import { formatAns, questionTypeLabel, statusLabel } from "../lib/format";
import { copyText, practiceTypeHref, sourceExcerptFor } from "../lib/review";
import { BandEstimate } from "../components/Charts";
import { Icon, PageHeading } from "../components/ReviewShared";
import type { Exam, Profile, ScoreReport, Session, Transcript } from "../types";

interface Loaded {
  session: Session;
  exam: Exam;
  report: ScoreReport | null;
  profile: Profile | null;
  transcript: Transcript | null;
}

export default function ResultsPage({ route }: { route: Route }) {
  const sessionId = route.query.get("session");
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    (async () => {
      if (!sessionId) {
        setError("链接里没有指定会话。请从「历史记录」选择一次已提交的考试查看复盘。");
        return;
      }
      try {
        const session = await loadSession(sessionId);
        const [exam, profile] = await Promise.all([loadExam(session.examId), loadProfile()]);
        const transcript = exam.module === "listening"
          ? await loadTranscript(exam.id).catch(() => null)
          : null;
        // Never trust a stored score: re-score against today's answer keys.
        // Non-submitted sessions are scored too — the page flags them with a
        // warning strip, and a partial raw score beats none.
        let report: ScoreReport | null = null;
        if (exam.module !== "writing") {
          const answers: Record<string, unknown> = {};
          for (const [qid, entry] of Object.entries(session.answers ?? {})) {
            // Stored answers are AnswerEntry objects; unwrap `.value` so the
            // report's userAnswer is the raw answer, but tolerate legacy rows
            // that already hold a bare value.
            answers[qid] = entry && typeof entry === "object" && "value" in entry ? entry.value : entry;
          }
          try {
            report = scoreExam(exam, answers);
          } catch {
            report = null;
          }
        }
        if (live) setData({ session, exam, report, profile, transcript });
      } catch (e) {
        if (live) setError(`无法打开这条记录：${String(e)}`);
      }
    })();
    return () => {
      live = false;
      window.clearTimeout(copyTimer.current);
    };
  }, [sessionId]);

  async function copyPrompt() {
    if (!data) return;
    try {
      await copyText(buildReviewPrompt(data.exam, data.session, data.report));
      setCopied(true);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 2400);
    } catch {
      setError("复制失败，请手动复制：浏览器可能限制了剪贴板权限。");
    }
  }

  if (error) {
    return <div className="results-page page-stack">
      <PageHeading eyebrow="成绩复盘" title="无法显示成绩" />
      <div className="workspace-card empty-state compact"><p className="meta">{error}</p></div>
      <div className="button-row">
        <button type="button" className="secondary-button" onClick={() => navigate("/app/history")}>去历史记录</button>
        <button type="button" className="secondary-button" onClick={() => navigate("/app")}>回工作台</button>
      </div>
    </div>;
  }

  if (!data) {
    return <div className="results-page page-stack">
      <PageHeading eyebrow="成绩复盘" title="正在读取成绩…" />
    </div>;
  }

  const { session, exam, report, profile, transcript } = data;
  const module = exam?.module ?? session.module;
  const writingEntries = Object.entries(session.writing ?? {}).filter(([, text]) => text != null);

  return <div className="results-page page-stack">
    <PageHeading
      eyebrow={session.mode === "practice" ? "练习复盘" : "模考已提交"}
      title={module === "writing" ? "作文已安全保存" : "本次成绩"}
      subtitle={exam?.title} />

    {session.status !== "submitted" && <div className="notice-strip warning">
      <Icon name="info" size={16} />这份会话还没有交卷（当前状态：{statusLabel(session.status)}），分数按目前已保存的作答计算。
      <button type="button" className="secondary-button" onClick={() => navigate("/app/exam", { exam: session.examId, session: session.id })}>回到考场继续</button>
    </div>}

    {session.integrity === "interrupted" && <div className="notice-strip warning">
      <Icon name="info" size={16} />本次会话曾中断，历史记录中会标记为「中断」，但已完成度与成绩照常统计。
    </div>}

    {report
      ? <div className="result-headline">
          <div className="result-score"><strong>{report.rawCorrect}</strong><span>/ {report.rawTotal}</span><small>原始分</small></div>
          <BandEstimate module={module} raw={report.rawCorrect} total={report.rawTotal} target={profile?.targetBand} />
        </div>
      : <div className="workspace-card"><p>{module === "writing"
          ? "写作不产生客观分。这里保留字数、时长和完成状态，可复制 Prompt 到外部模型批改。"
          : "本次没有生成成绩报告。若是客观题试卷，可能评分数据缺失或会话未完成；可到「历史记录」核对完成情况或重新考一次。"}</p></div>}

    {report && <div className="review-list">{report.questions.map((q) => {
      const excerpt = q.correct ? undefined : sourceExcerptFor(exam, transcript, q);
      return <details key={q.questionId} className={`review-item ${q.correct ? "ok" : "bad"}`} open={!q.correct && session.mode === "practice"}>
        <summary>Q{q.number} · {q.correct ? "正确" : "错误"} · 你的答案：{formatAns(q.userAnswer)}</summary>
        <p>题型：{questionTypeLabel(q.questionType)}</p>
        <p>可接受答案：{q.acceptedAnswers.join(" / ") || "—"}</p>
        {excerpt && <blockquote className="mistake-source">{excerpt}</blockquote>}
        {!q.correct && <a className="link-button" href={practiceTypeHref(q.questionType)}><Icon name="arrow" size={14} />练这个题型</a>}
      </details>;
    })}</div>}

    {writingEntries.map(([id, text]) => <article className="workspace-card writing-result" key={id}>
      <h3>{id}</h3>
      <span>{text.trim() ? text.trim().split(/\s+/).length : 0} 词</span>
      <pre>{text}</pre>
    </article>)}

    <div className="button-row">
      <button type="button" className="primary-button" onClick={() => navigate("/app/exam", { exam: session.examId, mode: session.mode })}>重考</button>
      <button type="button" className="secondary-button" onClick={() => void copyPrompt()}>
        {copied ? <><Icon name="check" size={15} />已复制，去外部模型粘贴</> : "复制复盘 Prompt"}
      </button>
      <button type="button" className="secondary-button" onClick={() => navigate("/app")}>回工作台</button>
    </div>
  </div>;
}
