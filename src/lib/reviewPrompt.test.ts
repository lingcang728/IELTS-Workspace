import { describe, expect, it } from "vitest";
import { buildReviewPrompt, unansweredCount } from "./reviewPrompt";
import type { Exam, ScoreReport, Session } from "./types";

const exam: Exam = {
  schemaVersion: 1,
  id: "t",
  title: "Official Academic Reading Sample",
  module: "reading",
  source: { kind: "official_sample" },
  policy: {
    pauseAllowed: false,
    answerVisible: false,
    aiAllowed: false,
    forceSubmit: true,
    audioSeekAllowed: false,
    strictNavigation: false,
    endCondition: { type: "fixed_duration", durationMs: 1000 },
    timeWarningsMs: [],
  },
  sections: [
    {
      id: "p1",
      title: "Passage 1",
      kind: "passage",
      content: { format: "plain", text: "The river flooded in 1842." },
      questionGroups: [
        {
          id: "g1",
          instruction: "Choose the correct letter.",
          questionType: "single_choice",
          scoringPolicy: "per_question",
          questions: [
            {
              id: "q1",
              number: 1,
              type: "single_choice",
              prompt: "When did the river flood?",
              options: [
                { id: "A", label: "A", text: "1742" },
                { id: "B", label: "B", text: "1842" },
              ],
              acceptedAnswers: ["B"],
            },
          ],
        },
      ],
    },
  ],
};

function sess(value: string | null): Session {
  return {
    schemaVersion: 1,
    id: "s",
    examId: "t",
    examTitle: exam.title,
    module: "reading",
    mode: "practice",
    status: "submitted",
    integrity: "clean",
    startedAt: "t",
    updatedAt: "t",
    remainingMs: 0,
    answers: {
      q1: {
        questionId: "q1",
        questionType: "single_choice",
        value,
        flagged: false,
        updatedAt: "t",
      },
    },
    highlights: [],
    notes: [],
    events: [],
  };
}

describe("buildReviewPrompt", () => {
  it("includes exam, answers, answer key, and estimated-band warning", () => {
    const report: ScoreReport = {
      schemaVersion: 1,
      examId: "t",
      rawCorrect: 1,
      rawTotal: 1,
      questions: [
        {
          questionId: "q1",
          number: 1,
          questionType: "single_choice",
          correct: true,
          userAnswer: "B",
          acceptedAnswers: ["B"],
        },
      ],
    };
    const text = buildReviewPrompt(exam, sess("B"), report);
    expect(text).toContain("Estimated");
    expect(text).toContain("Official Academic Reading Sample");
    expect(text).toContain("When did the river flood?");
    expect(text).toContain("Your answer: B");
    expect(text).toContain("Accepted answers");
    expect(text).toContain("1 / 1");
    expect(text).not.toMatch(/https?:\/\/api\.openai/);
  });

  it("includes writing text for writing module", () => {
    const w: Exam = {
      ...exam,
      module: "writing",
      sections: [
        {
          id: "task1",
          title: "Writing Task 1",
          kind: "writing_task",
          content: { format: "plain", text: "The chart shows..." },
          questionGroups: [],
        },
      ],
    };
    const s = sess(null);
    s.module = "writing";
    s.writing = { task1: "The chart illustrates a rise in exports." };
    const text = buildReviewPrompt(w, s, null);
    expect(text).toContain("The chart illustrates a rise in exports.");
    expect(text).toContain("Task Response");
  });
});

describe("unansweredCount", () => {
  it("counts blank objective answers", () => {
    expect(unansweredCount(exam, sess(null))).toBe(1);
    expect(unansweredCount(exam, sess("B"))).toBe(0);
  });
});
