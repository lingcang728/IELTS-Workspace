import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { AnalyticsReport, Bootstrap, Exam, ScoreReport, Session, SessionSummary } from "./types";

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
