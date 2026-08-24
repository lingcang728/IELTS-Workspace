import { describe, expect, it } from "vitest";
import { addDays, daysBetween, generatePlan, isoDay, todayEntry } from "./plan";
import type { ExamSummary, SessionSummary } from "./types";

const today = new Date(2026, 7, 24); // 2026-08-24, local

function exams(): ExamSummary[] {
  const make = (id: string, module: ExamSummary["module"]): ExamSummary =>
    ({ id, title: id, module, questionCount: 40 } as ExamSummary);
  return [
    make("l1", "listening"), make("l2", "listening"),
    make("r1", "reading"), make("r2", "reading"),
    make("w1", "writing"),
  ];
}

const base = {
  exams: exams(),
  sessions: [] as SessionSummary[],
  daysPerWeek: 5,
  openMistakes: 20,
  dueVocab: 40,
  today,
};

describe("date helpers", () => {
  it("formats a local date without drifting across the timezone", () => {
    expect(isoDay(today)).toBe("2026-08-24");
    expect(isoDay(addDays(today, 8))).toBe("2026-09-01");
  });

  it("counts whole days to a target", () => {
    expect(daysBetween(today, "2026-08-24")).toBe(0);
    expect(daysBetween(today, "2026-09-01")).toBe(8);
    expect(daysBetween(today, "2026-08-20")).toBe(-4);
    expect(daysBetween(today, "not-a-date")).toBeNull();
  });
});

describe("generatePlan", () => {
  it("plans up to the exam date, capped at four weeks", () => {
    expect(generatePlan({ ...base, examDate: "2026-09-01" }).days).toHaveLength(8);
    expect(generatePlan({ ...base, examDate: "2027-01-01" }).days).toHaveLength(28);
    expect(generatePlan({ ...base }).days).toHaveLength(14);
  });

  it("gives the requested number of study days per week", () => {
    const plan = generatePlan({ ...base, daysPerWeek: 3, examDate: "2026-08-31" });
    const studyDays = plan.days.filter((day) => day.mock).length;
    expect(studyDays).toBe(3);
  });

  it("never schedules an exam that was already submitted", () => {
    const sessions = [
      { examId: "l1", module: "listening", status: "submitted", updatedAt: "2026-08-20T10:00:00Z" },
      { examId: "r1", module: "reading", status: "submitted", updatedAt: "2026-08-21T10:00:00Z" },
    ] as unknown as SessionSummary[];
    const plan = generatePlan({ ...base, sessions });
    const scheduled = plan.days.map((day) => day.mock?.examId).filter(Boolean);
    expect(scheduled).not.toContain("l1");
    expect(scheduled).not.toContain("r1");
  });

  it("rotates through the three modules", () => {
    const plan = generatePlan({ ...base, daysPerWeek: 7 });
    const modules = plan.days.map((day) => day.mock?.module).filter(Boolean);
    expect(new Set(modules)).toEqual(new Set(["listening", "reading", "writing"]));
  });

  it("points intensive listening at the most recent listening session", () => {
    const sessions = [
      { examId: "l1", module: "listening", status: "submitted", title: "L1", updatedAt: "2026-08-20T10:00:00Z" },
      { examId: "l2", module: "listening", status: "submitted", title: "L2", updatedAt: "2026-08-23T10:00:00Z" },
    ] as unknown as SessionSummary[];
    const plan = generatePlan({ ...base, sessions });
    const first = plan.days.find((day) => day.intensive);
    expect(first?.intensive?.examId).toBe("l2");
  });

  it("derives daily targets from the real backlog, and keeps them sane", () => {
    const plan = generatePlan({ ...base, openMistakes: 0, dueVocab: 0 });
    const day = plan.days.find((d) => d.mock);
    expect(day?.vocabTarget).toBe(5);
    expect(day?.mistakeTarget).toBe(3);
    const heavy = generatePlan({ ...base, openMistakes: 9999, dueVocab: 9999 });
    const busy = heavy.days.find((d) => d.mock);
    expect(busy?.vocabTarget).toBe(30);
    expect(busy?.mistakeTarget).toBe(15);
  });

  it("copes with an exam date in the past by planning a default fortnight", () => {
    expect(generatePlan({ ...base, examDate: "2026-01-01" }).days).toHaveLength(14);
  });

  it("still produces days when the library is empty", () => {
    const plan = generatePlan({ ...base, exams: [] });
    expect(plan.days).toHaveLength(14);
    expect(plan.days.every((day) => day.mock === null || day.mock === undefined)).toBe(true);
  });
});

describe("todayEntry", () => {
  it("finds the entry for today", () => {
    const plan = generatePlan({ ...base });
    expect(todayEntry(plan, today)?.date).toBe("2026-08-24");
  });

  it("returns undefined when the plan does not cover today", () => {
    const plan = generatePlan({ ...base });
    expect(todayEntry(plan, new Date(2027, 0, 1))).toBeUndefined();
    expect(todayEntry(null, today)).toBeUndefined();
  });
});
