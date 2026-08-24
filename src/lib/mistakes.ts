/**
 * Turning a submitted session into mistakes-book entries.
 *
 * The value of a mistake is not "you got Q17 wrong" — it is the stem, your
 * answer, the accepted answer, and *where in the passage the answer lives*.
 * Without the last one a re-do is just guessing again, so `sourceExcerpt`
 * carries the sentence containing the accepted answer whenever one can be
 * found in the section text.
 */
import type { Exam, Mistake, ScoreReport } from "./types";
import { groupForQuestion, sectionForQuestion } from "./types";

/** The sentence in `text` that contains `needle`, or undefined. */
export function sentenceContaining(text: string, needle: string): string | undefined {
  const hay = text.trim();
  const term = needle.trim();
  if (!hay || term.length < 2) return undefined;
  const at = hay.toLowerCase().indexOf(term.toLowerCase());
  if (at === -1) return undefined;
  // Sentence bounds, falling back to a window when the text has no full stops
  // (a notes-completion layout, for instance).
  const before = Math.max(
    hay.lastIndexOf(".", at),
    hay.lastIndexOf("\n", at),
    hay.lastIndexOf("?", at),
  );
  const afterDot = hay.indexOf(".", at + term.length);
  const afterBreak = hay.indexOf("\n", at + term.length);
  const candidates = [afterDot, afterBreak].filter((index) => index !== -1);
  const after = candidates.length ? Math.min(...candidates) : -1;
  const start = before === -1 ? Math.max(0, at - 160) : before + 1;
  const end = after === -1 ? Math.min(hay.length, at + term.length + 160) : after + 1;
  return hay.slice(start, end).trim().replace(/\s+/g, " ");
}

export function mistakesFromReport(
  exam: Exam,
  report: ScoreReport,
): Omit<Mistake, "addedAt" | "updatedAt" | "streak" | "timesWrong" | "status">[] {
  const out: Omit<Mistake, "addedAt" | "updatedAt" | "streak" | "timesWrong" | "status">[] = [];
  for (const row of report.questions) {
    if (row.correct) continue;
    const section = sectionForQuestion(exam, row.questionId);
    const group = groupForQuestion(exam, row.questionId);
    const question = group?.questions.find((q) => q.id === row.questionId);
    const passage = section?.content?.text ?? "";
    const excerpt = row.acceptedAnswers
      .map((answer) => sentenceContaining(passage, answer))
      .find(Boolean);
    out.push({
      id: "",                       // the backend derives it from exam + question
      examId: exam.id,
      examTitle: exam.title,
      questionId: row.questionId,
      number: row.number,
      module: exam.module,
      questionType: row.questionType,
      prompt: question?.prompt ?? "",
      sourceExcerpt: excerpt,
      userAnswer: (row.userAnswer as string | string[] | null) ?? null,
      acceptedAnswers: row.acceptedAnswers,
    });
  }
  return out;
}
