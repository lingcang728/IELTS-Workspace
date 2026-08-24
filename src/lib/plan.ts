/**
 * Generating a day-by-day study plan.
 *
 * The workbench's job is to answer "what should I do today". That answer has
 * to come from real material — a specific exam the learner has not done, a
 * specific listening part, a real count of due vocabulary — or it is just
 * decoration. So the generator takes the actual library, the actual finished
 * sessions and the actual mistake/vocab counts, and never invents a task it
 * cannot link to.
 */
import type { ExamSummary, ModuleKind, PlanDay, SessionSummary, StudyPlan } from "./types";

export function isoDay(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  next.setDate(next.getDate() + days);
  return next;
}

/** Whole days from today to `date` (YYYY-MM-DD); negative once it has passed. */
export function daysBetween(from: Date, isoDate: string): number | null {
  const target = Date.parse(`${isoDate}T00:00:00`);
  if (!Number.isFinite(target)) return null;
  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  return Math.round((target - start) / 86_400_000);
}

export interface PlanInputs {
  exams: ExamSummary[];
  sessions: SessionSummary[];
  targetBand?: number;
  examDate?: string;
  daysPerWeek: number;
  /** Open mistakes and due vocabulary right now; drives the daily targets. */
  openMistakes: number;
  dueVocab: number;
  today?: Date;
}

const MODULE_CYCLE: ModuleKind[] = ["listening", "reading", "writing"];

/**
 * A plan covering the days up to the exam, capped at four weeks so it stays a
 * plan rather than a wish. Exams already submitted are never scheduled again.
 */
export function generatePlan(input: PlanInputs): StudyPlan {
  const today = input.today ?? new Date();
  const done = new Set(
    input.sessions.filter((s) => s.status === "submitted").map((s) => s.examId),
  );
  const pool = MODULE_CYCLE.map((module) =>
    input.exams.filter((exam) => exam.module === module && !done.has(exam.id)));
  const cursor = [0, 0, 0];

  const untilExam = input.examDate ? daysBetween(today, input.examDate) : null;
  const horizon = Math.max(1, Math.min(28, untilExam != null && untilExam > 0 ? untilExam : 14));
  const perWeek = Math.min(7, Math.max(1, Math.round(input.daysPerWeek)));

  const days: PlanDay[] = [];
  let studyIndex = 0;
  for (let offset = 0; offset < horizon; offset += 1) {
    const date = addDays(today, offset);
    // Spread the rest days evenly rather than resting on fixed weekdays: the
    // learner told us how many days a week, not which ones.
    const isStudyDay = Math.floor(((offset % 7) + 1) * perWeek / 7) >
                       Math.floor((offset % 7) * perWeek / 7);
    if (!isStudyDay) {
      days.push({ date: isoDay(date), vocabTarget: 0, mistakeTarget: 0, mock: null, intensive: null });
      continue;
    }
    const slot = studyIndex % MODULE_CYCLE.length;
    const candidates = pool[slot];
    const exam = candidates[cursor[slot] % Math.max(1, candidates.length)];
    if (exam) cursor[slot] += 1;

    // Intensive listening follows the listening paper done most recently, so
    // the day after a listening mock is spent on the same audio.
    const lastListening = [...input.sessions]
      .filter((s) => s.module === "listening" && s.status === "submitted")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];

    days.push({
      date: isoDay(date),
      mock: exam ? { examId: exam.id, title: exam.title, module: exam.module } : null,
      intensive: lastListening
        ? { examId: lastListening.examId, title: lastListening.title || lastListening.examId,
            part: (studyIndex % 4) + 1 }
        : null,
      vocabTarget: Math.min(30, Math.max(5, Math.ceil(input.dueVocab / Math.max(1, perWeek)))),
      mistakeTarget: Math.min(15, Math.max(3, Math.ceil(input.openMistakes / Math.max(1, horizon)))),
    });
    studyIndex += 1;
  }

  return {
    id: "current",
    updatedAt: new Date().toISOString(),
    targetBand: input.targetBand,
    examDate: input.examDate,
    daysPerWeek: perWeek,
    days,
  };
}

export function todayEntry(plan: StudyPlan | null, today = new Date()): PlanDay | undefined {
  return plan?.days.find((day) => day.date === isoDay(today));
}
