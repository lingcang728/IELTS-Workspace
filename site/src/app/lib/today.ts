/**
 * Today-page helpers: streak counting, the resumable-session pick, per-task
 * minute estimates and the local-day key the heatmap aggregates on.
 * Everything here is a pure function of real IndexedDB data — no fetching,
 * no invented numbers.
 */
import type { ExamSummary, PlanDay, Profile, SessionSummary } from "../types";

/**
 * Profile plus the field only the web onboarding knows about. The shared
 * Profile type belongs to every page, so the daily-minutes preference is
 * carried here as a structural extension; it round-trips through IndexedDB
 * because `saveProfile` stores the object as-is.
 */
export interface TodayProfile extends Profile {
  /** Minutes the learner can study per day, chosen at onboarding (15/30/60/90). */
  dailyMinutes?: number;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** YYYY-MM-DD in local time. */
export function localDayOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local day key for a stored ISO timestamp, or null when unparsable. */
export function localDayKey(iso?: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return localDayOf(new Date(t));
}

const ACTIVE_STATUSES = new Set<SessionSummary["status"]>(["submitted", "in_progress"]);

/**
 * Consecutive days with real study activity, ending today — or yesterday when
 * today has none yet, so the streak is not broken until a full day is missed.
 * A day counts when at least one submitted or in-progress session carries a
 * local updatedAt (startedAt as fallback) on it.
 */
export function studyStreak(sessions: SessionSummary[], now = new Date()): number {
  const days = new Set<string>();
  for (const s of sessions) {
    if (!ACTIVE_STATUSES.has(s.status)) continue;
    const key = localDayKey(s.updatedAt ?? s.startedAt);
    if (key) days.add(key);
  }
  const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (!days.has(localDayOf(cursor))) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (days.has(localDayOf(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

/**
 * The newest session that can still be resumed — in_progress, interrupted or
 * created (submitted/aborted are final). Sessions whose exam no longer exists
 * are skipped so the button never leads to a dead exam id.
 */
export function resumableSession(
  sessions: SessionSummary[],
  exams: ExamSummary[],
): SessionSummary | undefined {
  const known = new Set(exams.map((e) => e.id));
  return sessions.find(
    (s) =>
      (s.status === "in_progress" || s.status === "interrupted" || s.status === "created") &&
      known.has(s.examId),
  );
}

/**
 * Whether the plan's mock for the day has already been submitted — the plan is
 * generated once per day, so done-state is derived live from the sessions.
 */
export function mockSubmitted(day: PlanDay | undefined, sessions: SessionSummary[]): boolean {
  const examId = day?.mock?.examId;
  if (!examId) return false;
  return sessions.some((s) => s.examId === examId && s.status === "submitted");
}

/** Real sitting length for one paper: measured duration, else module default. */
export function examMinutes(exam: ExamSummary | undefined, module?: string): number {
  if (exam?.durationMs) return Math.max(1, Math.round(exam.durationMs / 60_000));
  const m = module ?? exam?.module;
  if (m === "listening") return 30;
  return 60; // reading and writing papers are 60-minute sittings
}

/**
 * Honest estimate of today's workload in minutes, built from the plan entry
 * and the real mistake/vocab backlogs (2 min per redo, 1 min per card, one
 * intensive part ≈ 15 min). Returns null when nothing is due — the card then
 * omits the line rather than showing a made-up number.
 */
export function estimateTodayMinutes(
  day: PlanDay | undefined,
  exams: ExamSummary[],
  openMistakes: number,
  dueVocab: number,
): number | null {
  if (!day) return null;
  let total = 0;
  let any = false;
  const mock = day.mock;
  if (mock) {
    total += examMinutes(
      exams.find((e) => e.id === mock.examId),
      mock.module,
    );
    any = true;
  }
  if (day.intensive) {
    total += 15;
    any = true;
  }
  if (openMistakes > 0) {
    total += 2 * Math.min(openMistakes, day.mistakeTarget || openMistakes);
    any = true;
  }
  if (dueVocab > 0) {
    total += Math.min(dueVocab, day.vocabTarget || dueVocab);
    any = true;
  }
  return any ? total : null;
}
