import type { Exam, ScoreReport, Session } from "./types";
import { allQuestions, groupForQuestion } from "./types";

function fmtAnswer(v: unknown): string {
  if (v == null || v === "") return "(blank)";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "(blank)";
  return String(v);
}

function optionLine(opt: { label: string; text: string }): string {
  return `${opt.label}. ${opt.text}`.trim();
}

export function buildReviewPrompt(exam: Exam, session: Session, report: ScoreReport | null): string {
  const lines: string[] = [];
  lines.push(
    "你是 IELTS Academic 考官兼辅导。请用简体中文回复。",
    "任何分数或 band 必须标明 Estimated，不是官方成绩，也不是本 App 的内置评分。",
    "客观题请对照可接受答案讲解对错原因；写作按 Task Response / Coherence and Cohesion / Lexical Resource / Grammatical Range and Accuracy 四点给 Estimated band 区间，并给出可直接改的句子。",
    "",
    `试卷: ${exam.title}`,
    `模块: ${exam.module}`,
    `模式: ${session.mode}`,
  );
  if (report) {
    lines.push(`本地客观 raw score（答案键对照，不是 AI）: ${report.rawCorrect} / ${report.rawTotal}`);
  }
  lines.push("");

  if (exam.module === "writing") {
    for (const sec of exam.sections) {
      lines.push(`## ${sec.title}`);
      if (sec.content?.text) lines.push(sec.content.text.trim(), "");
      const text = session.writing?.[sec.id] ?? "";
      const words = text.trim() ? text.trim().split(/\s+/).length : 0;
      lines.push("考生作文:", text.trim() || "(empty)", `Word count: ${words}`, "");
    }
  } else {
    const reportById = new Map((report?.questions ?? []).map((q) => [q.questionId, q]));
    for (const sec of exam.sections) {
      lines.push(`## ${sec.title}`);
      if (sec.content?.text) {
        lines.push("Passage / context:", sec.content.text.trim(), "");
      }
      for (const g of sec.questionGroups) {
        lines.push(`Instruction: ${g.instruction}`);
        if (g.sharedOptions?.length) {
          lines.push("Shared options:");
          for (const opt of g.sharedOptions) lines.push(`- ${optionLine(opt)}`);
        }
        if (g.wordBank?.length) lines.push(`Word bank: ${g.wordBank.join(", ")}`);
        for (const q of g.questions) {
          const ans = session.answers[q.id]?.value;
          const scored = reportById.get(q.id);
          const options = q.options?.length ? q.options : g.sharedOptions;
          lines.push(`Q${q.number} [${q.type}] ${q.prompt}${q.gapText ? ` | ${q.gapText}` : ""}`);
          if (options?.length) {
            for (const opt of options) lines.push(`  ${optionLine(opt)}`);
          }
          lines.push(`  Your answer: ${fmtAnswer(ans)}`);
          const accepted = scored?.acceptedAnswers?.length ? scored.acceptedAnswers : q.acceptedAnswers;
          if (accepted?.length) {
            lines.push(`  Accepted answers (answer key, for explanation only): ${accepted.join(" / ")}`);
          }
          if (scored) lines.push(`  Local mark: ${scored.correct ? "correct" : "incorrect"}`);
        }
        lines.push("");
      }
    }
  }

  lines.push(
    "请按题目编号逐题讲解。不要把 Estimated band 写成官方成绩。写完后给 3 条下一步练习建议。",
  );
  return lines.join("\n");
}

export function unansweredCount(exam: Exam, session: Session): number {
  if (exam.module === "writing") {
    return exam.sections.filter((s) => !(session.writing?.[s.id] ?? "").trim()).length;
  }
  return allQuestions(exam).filter((q) => {
    const v = session.answers[q.id]?.value;
    if (v == null || v === "") return true;
    if (Array.isArray(v) && v.length === 0) return true;
    return false;
  }).length;
}

export function groupTypeOf(exam: Exam, questionId: string) {
  return groupForQuestion(exam, questionId)?.questionType;
}
