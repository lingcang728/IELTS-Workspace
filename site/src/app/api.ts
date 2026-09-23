/**
 * Web implementation of the desktop `src/lib/api.ts` surface. Same function
 * names and semantics, backed by IndexedDB + /content fetches instead of
 * Tauri commands. Pages ported from src/ should only need their import path
 * changed to "../api" (or "@app/api").
 */
import {
  contentIndex,
  invalidateContentIndex,
  loadExam as loadExamContent,
  loadTranscript,
  playbackSourceFor,
  assetSrc,
  saveBlob,
  saveImportedExam,
} from "./content";
import { idbAll, idbDel, idbGet, idbKeys, idbSet } from "./idb";
import { scoreExam as scoreExamInner } from "./scoring";
import { analyticsReport as analyticsInner } from "./analytics";
import { initial as srsInitial, intervalDays, retrievability, review as srsReview, type Memory } from "./lib/srs";
import type {
  AnalyticsReport,
  Bootstrap,
  Exam,
  Mistake,
  Profile,
  SavedFeedback,
  ScoreReport,
  Session,
  SessionSummary,
  StudyPlan,
  Transcript,
  VocabCard,
  VocabGrade,
} from "./types";

const nowIso = () => new Date().toISOString();
const epochDay = () => Math.floor(Date.now() / 86_400_000);
const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const isoToEpochDay = (iso?: string | null) => {
  if (!iso) return null;
  const t = Date.parse(iso.length === 10 ? `${iso}T00:00:00` : iso);
  return Number.isFinite(t) ? Math.floor(t / 86_400_000) : null;
};

/* ------------------------------------------------------------------ exams */

export { assetSrc, playbackSourceFor, saveBlob, loadTranscript };

export async function loadExam(id: string): Promise<Exam> {
  return loadExamContent(id);
}

export async function listExams() {
  return (await contentIndex()).exams;
}

export async function importExam(json: string): Promise<{ id: string }> {
  const exam = JSON.parse(json) as Exam;
  if (exam.schemaVersion !== 1 || !exam.id || !Array.isArray(exam.sections)) {
    throw new Error("试卷 JSON 缺少 schemaVersion/id/sections");
  }
  if (exam.source?.kind === "generated_practice") {
    throw new Error("generated_practice 来源的试卷不入库");
  }
  await saveImportedExam(exam);
  return { id: exam.id };
}

export async function importTranscript(examId: string, transcript: Transcript): Promise<void> {
  await idbSet("transcripts", examId, transcript);
  invalidateContentIndex();
}

/* ---------------------------------------------------------------- sessions */

function toSummary(s: Session, total?: number): SessionSummary {
  const answered = Object.values(s.answers ?? {}).filter(
    (a) => a.value != null && a.value !== "" && !(Array.isArray(a.value) && a.value.length === 0),
  ).length;
  return {
    id: s.id,
    examId: s.examId,
    module: s.module,
    mode: s.mode,
    status: s.status,
    integrity: s.integrity,
    startedAt: s.startedAt,
    updatedAt: s.updatedAt,
    title: s.examTitle,
    answered,
    total,
  };
}

export async function saveSession(session: Session): Promise<string> {
  session.updatedAt = nowIso();
  await idbSet("sessions", session.id, session);
  return session.id;
}

export async function loadSession(id: string): Promise<Session> {
  const s = await idbGet<Session>("sessions", id);
  if (!s) throw new Error("找不到该会话");
  return s;
}

export async function listSessions(): Promise<SessionSummary[]> {
  const [all, index] = await Promise.all([idbAll<Session>("sessions"), contentIndex()]);
  const totals = new Map(index.exams.map((e) => [e.id, e.questionCount]));
  return all
    .filter((s) => !(s as Session & { archived?: boolean }).archived)
    .map((s) => toSummary(s, totals.get(s.examId)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function discardSession(id: string): Promise<void> {
  await idbDel("sessions", id);
}

export async function archiveSession(id: string): Promise<void> {
  const s = await idbGet<Session>("sessions", id);
  if (s) await idbSet("sessions", id, { ...s, archived: true });
}

export async function scoreExam(examId: string, answers: Record<string, unknown>): Promise<ScoreReport> {
  const exam = await loadExam(examId);
  return scoreExamInner(exam, answers);
}

/* ---------------------------------------------------------------- profile / bootstrap */

export async function loadProfile(): Promise<Profile | null> {
  return (await idbGet<Profile>("kv", "profile")) ?? null;
}

export async function saveProfile(profile: Profile): Promise<void> {
  await idbSet("kv", "profile", profile);
}

export async function bootstrap(): Promise<Bootstrap> {
  const [index, sessions, profile] = await Promise.all([
    contentIndex(),
    listSessions(),
    loadProfile(),
  ]);
  return {
    probe: { ok: true, dataRoot: "indexeddb://ielts-workspace", appRoot: "/", dev: import.meta.env.DEV },
    exams: index.exams,
    sessions,
    profile,
    audio: null,
    diagnostics: { warnings: [], sessionsQuarantined: [] },
  };
}

/* ---------------------------------------------------------------- mistakes */

const MASTERED_STREAK = 3;
const mistakeId = (examId: string, questionId: string) =>
  `${examId}__${questionId}`.replace(/[. ]/g, "-");

export async function mistakeAdd(entries: unknown[]): Promise<{ added: number; refreshed: number }> {
  const existing = (await idbGet<Mistake[]>("kv", "mistakes")) ?? [];
  let added = 0;
  let refreshed = 0;
  for (const raw of entries) {
    const entry = raw as Partial<Mistake>;
    if (!entry.examId || !entry.questionId) continue;
    const id = mistakeId(entry.examId, entry.questionId);
    const previous = existing.find((m) => m.id === id);
    const record: Mistake = {
      ...(entry as Mistake),
      id,
      addedAt: previous?.addedAt ?? nowIso(),
      updatedAt: nowIso(),
      streak: 0,
      status: "open",
      timesWrong: (previous?.timesWrong ?? 0) + 1,
    };
    const at = existing.findIndex((m) => m.id === id);
    if (at >= 0) {
      existing[at] = record;
      refreshed += 1;
    } else {
      existing.push(record);
      added += 1;
    }
  }
  await idbSet("kv", "mistakes", existing);
  return { added, refreshed };
}

export async function mistakeList(): Promise<Mistake[]> {
  const all = (await idbGet<Mistake[]>("kv", "mistakes")) ?? [];
  return all.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

export async function mistakeResolve(id: string, correct: boolean): Promise<Mistake> {
  const all = (await idbGet<Mistake[]>("kv", "mistakes")) ?? [];
  const record = all.find((m) => m.id === id);
  if (!record) throw new Error("找不到该错题");
  const streak = correct ? (record.streak ?? 0) + 1 : 0;
  record.streak = streak;
  record.updatedAt = nowIso();
  if (!correct) record.timesWrong = (record.timesWrong ?? 0) + 1;
  record.status = streak >= MASTERED_STREAK ? "mastered" : "open";
  await idbSet("kv", "mistakes", all);
  return record;
}

export async function mistakeDelete(id: string): Promise<void> {
  const all = (await idbGet<Mistake[]>("kv", "mistakes")) ?? [];
  await idbSet("kv", "mistakes", all.filter((m) => m.id !== id));
}

/* ------------------------------------------------------------------ vocab */

const DEFAULT_RETENTION = 0.9;

export async function vocabAdd(entry: {
  term?: string;
  note?: string;
  sighting?: VocabCard["sightings"][number];
}): Promise<VocabCard> {
  const term = (entry.term ?? "").trim();
  if (!term) throw new Error("生词缺少 term");
  const slug = term.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const id = slug ? `w-${slug}` : `w-${Date.now().toString(16)}`;
  const all = (await idbGet<VocabCard[]>("kv", "vocab")) ?? [];
  const existing = all.find((c) => c.id === id);
  if (existing) {
    const sightings = existing.sightings ?? [];
    if (entry.sighting && !sightings.some((s) => JSON.stringify(s) === JSON.stringify(entry.sighting))) {
      sightings.push(entry.sighting);
    }
    existing.sightings = sightings;
    existing.updatedAt = nowIso();
    await idbSet("kv", "vocab", all);
    return existing;
  }
  const card: VocabCard = {
    id,
    term,
    note: entry.note,
    sightings: entry.sighting ? [entry.sighting] : [],
    addedAt: nowIso(),
    updatedAt: nowIso(),
    reps: 0,
    lapses: 0,
  };
  all.push(card);
  await idbSet("kv", "vocab", all);
  return card;
}

export async function vocabList(): Promise<VocabCard[]> {
  const all = (await idbGet<VocabCard[]>("kv", "vocab")) ?? [];
  return all.sort((a, b) => (b.addedAt ?? "").localeCompare(a.addedAt ?? ""));
}

export async function vocabDue(limit?: number): Promise<VocabCard[]> {
  const today = epochDay();
  const all = (await idbGet<VocabCard[]>("kv", "vocab")) ?? [];
  const due = all
    .filter((c) => {
      const dueDay = isoToEpochDay(c.dueOn);
      return dueDay == null || dueDay <= today;
    })
    .map((c) => {
      const memory: Memory | undefined =
        c.stability != null && c.difficulty != null
          ? { stability: c.stability, difficulty: c.difficulty }
          : undefined;
      const last = isoToEpochDay(c.lastReviewOn);
      const priority =
        memory && last != null ? retrievability(memory.stability, today - last) : -1;
      return { priority, card: c };
    })
    .sort((a, b) => a.priority - b.priority);
  return due.slice(0, limit ?? due.length).map((d) => d.card);
}

export async function vocabReview(id: string, grade: VocabGrade, retention?: number): Promise<VocabCard> {
  if (grade < 1 || grade > 4) throw new Error("评分必须是 1-4");
  const all = (await idbGet<VocabCard[]>("kv", "vocab")) ?? [];
  const card = all.find((c) => c.id === id);
  if (!card) throw new Error("找不到该生词");
  const today = epochDay();
  const last = isoToEpochDay(card.lastReviewOn);
  const elapsed = last != null ? today - last : 0;
  const previous: Memory | undefined =
    card.stability != null && card.difficulty != null
      ? { stability: card.stability, difficulty: card.difficulty }
      : undefined;
  const memory = srsReview(previous, elapsed, grade);
  const interval = Math.max(1, Math.round(intervalDays(memory.stability, retention ?? DEFAULT_RETENTION)));
  card.stability = memory.stability;
  card.difficulty = memory.difficulty;
  card.intervalDays = interval;
  card.lastReviewOn = isoDay(new Date());
  card.dueOn = isoDay(new Date(Date.now() + interval * 86_400_000));
  card.reps = (card.reps ?? 0) + 1;
  if (grade === 1) card.lapses = (card.lapses ?? 0) + 1;
  card.updatedAt = nowIso();
  await idbSet("kv", "vocab", all);
  return card;
}

export async function vocabDelete(id: string): Promise<void> {
  const all = (await idbGet<VocabCard[]>("kv", "vocab")) ?? [];
  await idbSet("kv", "vocab", all.filter((c) => c.id !== id));
}

/** Used by the study-plan generator: how many cards are due right now. */
export async function vocabDueCount(): Promise<number> {
  return (await vocabDue()).length;
}

/* -------------------------------------------------------------------- plan */

export async function planGet(): Promise<StudyPlan | null> {
  return (await idbGet<StudyPlan>("kv", "plan-current")) ?? null;
}

export async function planSave(plan: unknown): Promise<StudyPlan> {
  const record = { ...(plan as object), id: "current" as const, updatedAt: nowIso() } as StudyPlan;
  await idbSet("kv", "plan-current", record);
  return record;
}

/* ---------------------------------------------------------------- feedback */

let feedbackSeq = 0;

export async function feedbackSave(entry: unknown): Promise<SavedFeedback> {
  const all = (await idbGet<SavedFeedback[]>("kv", "feedback")) ?? [];
  const record = {
    ...(entry as object),
    id: (entry as SavedFeedback).id ?? `f-${Date.now()}-${feedbackSeq++}`,
    savedAt: nowIso(),
  } as SavedFeedback;
  all.push(record);
  await idbSet("kv", "feedback", all);
  return record;
}

export async function feedbackList(): Promise<SavedFeedback[]> {
  const all = (await idbGet<SavedFeedback[]>("kv", "feedback")) ?? [];
  return all.sort((a, b) => (b.savedAt ?? "").localeCompare(a.savedAt ?? ""));
}

export async function feedbackDelete(id: string): Promise<void> {
  const all = (await idbGet<SavedFeedback[]>("kv", "feedback")) ?? [];
  await idbSet("kv", "feedback", all.filter((f) => f.id !== id));
}

/* --------------------------------------------------------------- analytics */

export async function analyticsReport(rangeDays = 30): Promise<AnalyticsReport> {
  return analyticsInner(rangeDays);
}

/* ------------------------------------------------------------- diagnostics */

export { idbKeys, idbGet, idbSet, idbDel };

/** Seed an FSRS state — exposed for tests and for the vocab page's hints. */
export const srs = { initial: srsInitial, intervalDays, retrievability, review: srsReview };
