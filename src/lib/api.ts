import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type {
  AnalyticsReport, Bootstrap, Exam, Mistake, SavedFeedback, ScoreReport, Session,
  SessionSummary, StudyPlan, Transcript, VocabCard, VocabGrade,
} from "./types";

export async function bootstrap(): Promise<Bootstrap> {
  return invoke("bootstrap");
}

export async function saveSession(session: Session): Promise<string> {
  return invoke("save_session", { json: JSON.stringify(session) });
}

export async function loadSession(id: string): Promise<Session> {
  const raw = await invoke<string>("load_session", { id });
  return JSON.parse(raw) as Session;
}

export async function listSessions(): Promise<SessionSummary[]> {
  return invoke("list_sessions");
}

export async function discardSession(id: string): Promise<void> {
  return invoke("discard_session", { id });
}

export async function archiveSession(id: string): Promise<void> {
  return invoke("archive_session", { id });
}

export async function loadExam(id: string): Promise<Exam> {
  return invoke("load_exam", { id });
}

export async function importExam(json: string) {
  return invoke("import_exam", { json });
}

export async function scoreExam(examId: string, answers: Record<string, unknown>): Promise<ScoreReport> {
  return invoke("score_exam", { examId, answersJson: JSON.stringify(answers) });
}

export async function saveProfile(profile: unknown): Promise<void> {
  return invoke("save_profile", { json: JSON.stringify(profile) });
}

export async function analyticsReport(rangeDays = 30): Promise<AnalyticsReport> {
  return invoke("analytics_report", { rangeDays });
}

export async function assetSrc(rel: string): Promise<string> {
  const abs = await invoke<string>("resolve_asset", { rel });
  return convertFileSrc(abs);
}

/* ------------------------------------------------------------------ Phase 3 */

export async function mistakeAdd(entries: unknown[]): Promise<{ added: number; refreshed: number }> {
  return invoke("mistake_add", { entriesJson: JSON.stringify(entries) });
}

export async function mistakeList(): Promise<Mistake[]> {
  return invoke("mistake_list");
}

export async function mistakeResolve(id: string, correct: boolean): Promise<Mistake> {
  return invoke("mistake_resolve", { id, correct });
}

export async function mistakeDelete(id: string): Promise<void> {
  return invoke("mistake_delete", { id });
}

export async function vocabAdd(entry: unknown): Promise<VocabCard> {
  return invoke("vocab_add", { entryJson: JSON.stringify(entry) });
}

export async function vocabList(): Promise<VocabCard[]> {
  return invoke("vocab_list");
}

export async function vocabDue(limit?: number): Promise<VocabCard[]> {
  return invoke("vocab_due", { limit });
}

export async function vocabReview(id: string, grade: VocabGrade, retention?: number): Promise<VocabCard> {
  return invoke("vocab_review", { id, grade, retention });
}

export async function vocabDelete(id: string): Promise<void> {
  return invoke("vocab_delete", { id });
}

export async function planGet(): Promise<StudyPlan | null> {
  return invoke("plan_get");
}

export async function planSave(plan: unknown): Promise<StudyPlan> {
  return invoke("plan_save", { planJson: JSON.stringify(plan) });
}

export async function feedbackSave(entry: unknown): Promise<SavedFeedback> {
  return invoke("feedback_save", { entryJson: JSON.stringify(entry) });
}

export async function feedbackList(): Promise<SavedFeedback[]> {
  return invoke("feedback_list");
}

export async function feedbackDelete(id: string): Promise<void> {
  return invoke("feedback_delete", { id });
}

export async function loadTranscript(examId: string): Promise<Transcript | null> {
  return invoke("load_transcript", { examId });
}
