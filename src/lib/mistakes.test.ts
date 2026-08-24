import { describe, expect, it } from "vitest";
import { mistakesFromReport, sentenceContaining } from "./mistakes";
import type { Exam, ScoreReport } from "./types";

const passage =
  "Stepwells were fundamental to life in the driest parts of India. " +
  "During their heyday they were places of gathering and worship. " +
  "The oldest surviving example was built in Gujarat.";

function exam(): Exam {
  return {
    schemaVersion: 1,
    id: "c10-t1-r",
    title: "Cambridge IELTS 10 Test 1 Reading",
    module: "reading",
    policy: {
      pauseAllowed: true,
      answerVisible: false,
      aiAllowed: false,
      forceSubmit: false,
      audioSeekAllowed: true,
      strictNavigation: false,
      endCondition: { type: "fixed_duration", durationMs: 3_600_000 },
      timeWarningsMs: [],
    },
    sections: [
      {
        id: "p1",
        title: "Reading Passage 1",
        kind: "reading_passage",
        content: { format: "plain", text: passage },
        questionGroups: [
          {
            id: "g1",
            questionType: "completion",
            instruction: "Complete the notes below.",
            questions: [
              { id: "q1", number: 1, type: "completion", prompt: "Built in ___", acceptedAnswers: ["Gujarat"] },
              { id: "q2", number: 2, type: "completion", prompt: "Used for ___", acceptedAnswers: ["worship"] },
            ],
          },
        ],
      },
    ],
  } as unknown as Exam;
}

const report: ScoreReport = {
  schemaVersion: 1,
  examId: "c10-t1-r",
  rawCorrect: 1,
  rawTotal: 2,
  questions: [
    { questionId: "q1", number: 1, questionType: "completion", correct: false, userAnswer: "Delhi", acceptedAnswers: ["Gujarat"] },
    { questionId: "q2", number: 2, questionType: "completion", correct: true, userAnswer: "worship", acceptedAnswers: ["worship"] },
  ],
};

describe("sentenceContaining", () => {
  it("returns the sentence holding the answer", () => {
    expect(sentenceContaining(passage, "Gujarat")).toBe(
      "The oldest surviving example was built in Gujarat.",
    );
  });

  it("is case-insensitive", () => {
    expect(sentenceContaining(passage, "gujarat")).toContain("Gujarat");
  });

  it("returns undefined when the answer is not in the text", () => {
    expect(sentenceContaining(passage, "Rajasthan")).toBeUndefined();
  });

  it("returns undefined rather than guessing for a one-character answer", () => {
    expect(sentenceContaining(passage, "a")).toBeUndefined();
  });

  it("falls back to a window when there is no sentence boundary", () => {
    const notes = "ADDRESS 48 North Avenue Westsea POSTCODE WS6 2YH";
    expect(sentenceContaining(notes, "North Avenue")).toContain("North Avenue");
  });
});

describe("mistakesFromReport", () => {
  it("keeps only the wrong answers", () => {
    const out = mistakesFromReport(exam(), report);
    expect(out).toHaveLength(1);
    expect(out[0].questionId).toBe("q1");
  });

  it("carries the stem, both answers and the source sentence", () => {
    const [entry] = mistakesFromReport(exam(), report);
    expect(entry.prompt).toBe("Built in ___");
    expect(entry.userAnswer).toBe("Delhi");
    expect(entry.acceptedAnswers).toEqual(["Gujarat"]);
    expect(entry.sourceExcerpt).toContain("Gujarat");
  });

  it("leaves the excerpt undefined when the answer is not quotable", () => {
    const listening = exam();
    listening.sections[0].content = { format: "plain", text: "" };
    const [entry] = mistakesFromReport(listening, report);
    expect(entry.sourceExcerpt).toBeUndefined();
  });
});
