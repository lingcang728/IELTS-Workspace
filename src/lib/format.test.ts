import { describe, expect, it } from "vitest";
import { completion, isFinished, moduleLabel, questionTypeLabel, sourceLabel } from "./format";
import type { ExamSummary } from "./types";
import type { SessionSummary } from "./types";

function session(patch: Partial<SessionSummary>): SessionSummary {
  return {
    id: "s1", examId: "e1", module: "reading", mode: "practice",
    status: "submitted", integrity: "clean",
    startedAt: "2026-08-24T09:00:00Z", updatedAt: "2026-08-24T10:00:00Z",
    ...patch,
  };
}

describe("completion", () => {
  it("is the answered share of the paper", () => {
    expect(completion(session({ answered: 20, total: 40 }))).toBe(0.5);
    expect(completion(session({ answered: 40, total: 40 }))).toBe(1);
    expect(completion(session({ answered: 0, total: 40 }))).toBe(0);
  });

  it("never exceeds 1", () => {
    expect(completion(session({ answered: 41, total: 40 }))).toBe(1);
  });

  it("is null when the summary carries no progress", () => {
    expect(completion(session({}))).toBeNull();
    expect(completion(session({ answered: 3, total: 0 }))).toBeNull();
  });
});

describe("moduleLabel", () => {
  it("uses Chinese names in the shell", () => {
    expect(moduleLabel("reading")).toBe("阅读");
    expect(moduleLabel("listening")).toBe("听力");
    expect(moduleLabel("writing")).toBe("写作");
  });
});

describe("questionTypeLabel", () => {
  it("maps exam types to Chinese names in the shell", () => {
    expect(questionTypeLabel("multi_choice")).toBe("多选题");
    expect(questionTypeLabel("matching")).toBe("配对题");
    expect(questionTypeLabel("unknown_type")).toBe("unknown type");
  });
});

describe("sourceLabel", () => {
  it("names Cambridge papers as project-prepared books", () => {
    const exam = {
      id: "cambridge-18-test-1-listening",
      title: "Cambridge IELTS 18 Academic Test 1 Listening",
      module: "listening",
      source: { kind: "cambridge_book", title: "Cambridge IELTS 18" },
      path: "",
      questionCount: 40,
    } as ExamSummary;
    expect(sourceLabel(exam)).toBe("剑桥雅思 18 · 本项目整理");
  });
});

describe("isFinished", () => {
  it("does not call a barely-attempted submission finished", () => {
    // The bug this exists for: two questions answered, then submit.
    expect(isFinished(session({ answered: 2, total: 40 }))).toBe(false);
    expect(isFinished(session({ answered: 20, total: 40 }))).toBe(false);
  });

  it("accepts a paper that was essentially completed", () => {
    expect(isFinished(session({ answered: 40, total: 40 }))).toBe(true);
    expect(isFinished(session({ answered: 36, total: 40 }))).toBe(true);
  });

  it("rejects anything not submitted, however complete", () => {
    expect(isFinished(session({ answered: 40, total: 40, status: "in_progress" }))).toBe(false);
    expect(isFinished(session({ answered: 40, total: 40, status: "interrupted" }))).toBe(false);
  });

  it("falls back to status for records with no progress data", () => {
    expect(isFinished(session({}))).toBe(true);
    expect(isFinished(session({ status: "in_progress" }))).toBe(false);
  });
});
