/**
 * TypeScript port of `src-tauri/src/scoring.rs`. Keep behaviour identical:
 * trim, collapse whitespace, lowercase — no fuzzy matching, no colour/color
 * expansion. Variants belong in the exam JSON's acceptedAnswers.
 */
import type { Exam, ScoreReport } from "./types";

type Json = unknown;

export function normalizeAnswer(raw: string): string {
  return raw.trim().split(/\s+/).join(" ").toLowerCase();
}

export function answersMatch(accepted: string[], given: string | null | undefined): boolean {
  if (given == null) return false;
  const n = normalizeAnswer(given);
  if (!n) return false;
  return accepted.some((item) => normalizeAnswer(item) === n);
}

interface GroupJson {
  scoringPolicy?: string;
  acceptedAnswers?: string[];
  questions?: QuestionJson[];
}

interface QuestionJson {
  id?: string;
  number?: number;
  type?: string;
  acceptedAnswers?: string[];
}

function acceptedList(question: QuestionJson, group: GroupJson): string[] {
  if (Array.isArray(question.acceptedAnswers) && question.acceptedAnswers.length > 0) {
    return question.acceptedAnswers.filter((a): a is string => typeof a === "string");
  }
  if (Array.isArray(group.acceptedAnswers)) {
    return group.acceptedAnswers.filter((a): a is string => typeof a === "string");
  }
  return [];
}

function answerTokens(value: Json): string[] {
  const unnested =
    value && typeof value === "object" && !Array.isArray(value) && "value" in value
      ? (value as { value: Json }).value
      : value;
  if (unnested == null) return [];
  if (typeof unnested === "string") {
    const n = normalizeAnswer(unnested);
    return n ? [n] : [];
  }
  if (typeof unnested === "number" || typeof unnested === "boolean") {
    return [normalizeAnswer(String(unnested))];
  }
  if (Array.isArray(unnested)) {
    return unnested
      .filter((s): s is string => typeof s === "string")
      .map(normalizeAnswer)
      .filter((s) => s.length > 0);
  }
  const n = normalizeAnswer(String(unnested));
  return n ? [n] : [];
}

function valueToCompare(value: Json): string | null {
  const unnested =
    value && typeof value === "object" && !Array.isArray(value) && "value" in value
      ? (value as { value: Json }).value
      : value;
  if (unnested == null) return null;
  if (typeof unnested === "string") return unnested;
  if (typeof unnested === "number" || typeof unnested === "boolean") return String(unnested);
  if (Array.isArray(unnested)) {
    const parts = unnested.filter((s): s is string => typeof s === "string").sort();
    return parts.length ? parts.join("|") : null;
  }
  return String(unnested);
}

function scoreOne(question: QuestionJson, group: GroupJson, answers: Record<string, Json>) {
  const accepted = acceptedList(question, group);
  const userVal = answers[question.id ?? ""];
  return {
    questionId: question.id ?? "",
    number: question.number ?? 0,
    questionType: question.type ?? "unknown",
    correct: answersMatch(accepted, valueToCompare(userVal)),
    userAnswer: userVal ?? null,
    acceptedAnswers: accepted,
  };
}

function scoreInEitherOrder(
  group: GroupJson,
  questions: QuestionJson[],
  answers: Record<string, Json>,
  out: ScoreReport["questions"],
) {
  let remaining: string[] = Array.isArray(group.acceptedAnswers)
    ? group.acceptedAnswers
        .filter((a): a is string => typeof a === "string")
        .map(normalizeAnswer)
        .filter((s) => s.length > 0)
    : [];
  if (remaining.length === 0) {
    for (const q of questions) {
      for (const item of q.acceptedAnswers ?? []) {
        const norm = normalizeAnswer(item);
        if (norm && !remaining.includes(norm)) remaining.push(norm);
      }
    }
  }

  let acceptedDisplay: string[] = Array.isArray(group.acceptedAnswers)
    ? group.acceptedAnswers.filter((a): a is string => typeof a === "string")
    : [];
  if (acceptedDisplay.length === 0) {
    for (const q of questions) {
      for (const item of q.acceptedAnswers ?? []) {
        if (item && !acceptedDisplay.includes(item)) acceptedDisplay.push(item);
      }
    }
  }

  for (const q of questions) {
    const userVal = answers[q.id ?? ""];
    let correct = false;
    for (const g of answerTokens(userVal)) {
      const pos = remaining.indexOf(g);
      if (pos >= 0) {
        remaining.splice(pos, 1);
        correct = true;
      }
    }
    out.push({
      questionId: q.id ?? "",
      number: q.number ?? 0,
      questionType: q.type ?? "unknown",
      correct,
      userAnswer: userVal ?? null,
      acceptedAnswers: [...acceptedDisplay],
    });
  }
}

export function scoreExam(exam: Exam, answers: Record<string, Json>): ScoreReport {
  const questionsOut: ScoreReport["questions"] = [];
  for (const section of exam.sections ?? []) {
    for (const group of section.questionGroups ?? []) {
      const questions = (group.questions ?? []) as QuestionJson[];
      if (group.scoringPolicy === "in_either_order") {
        scoreInEitherOrder(group as GroupJson, questions, answers, questionsOut);
      } else {
        for (const q of questions) questionsOut.push(scoreOne(q, group as GroupJson, answers));
      }
    }
  }
  return {
    schemaVersion: 1,
    examId: exam.id ?? "unknown",
    rawCorrect: questionsOut.filter((q) => q.correct).length,
    rawTotal: questionsOut.length,
    questions: questionsOut,
  };
}
