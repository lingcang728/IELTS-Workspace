/** Display formatting shared across the shell pages. No React, no side effects. */
import type { ExamSummary, SessionSummary } from "./types";

export function sourceLabel(exam: ExamSummary) {
  if (exam.source?.kind === "official_sample") return "IELTS Official";
  if (exam.source?.kind === "cambridge_book") {
    const fromId = exam.id.match(/^cambridge-(\d+)/);
    const fromTitle = (exam.source.title || "").match(/(\d+)/);
    const book = fromId?.[1] || fromTitle?.[1];
    return book ? `剑桥雅思 ${book} · 本项目整理` : "剑桥雅思 · 本项目整理";
  }
  if (exam.source?.kind === "imported_document") return exam.source.title || "本地导入";
  return exam.source?.title || "本地题库";
}

export function moduleLabel(module: ExamSummary["module"]) {
  return ({ reading: "阅读", listening: "听力", writing: "写作", speaking: "口语" } as const)[module];
}

const QUESTION_TYPE_LABELS: Record<string, string> = {
  single_choice: "单选题",
  multi_choice: "多选题",
  true_false_ng: "判断题 T/F/NG",
  yes_no_ng: "判断题 Y/N/NG",
  completion: "填空题",
  matching: "配对题",
  labelling: "标注题",
};

export function questionTypeLabel(type: string) {
  return QUESTION_TYPE_LABELS[type] ?? type.replaceAll("_", " ");
}

export function durationLabel(exam: ExamSummary) {
  if (exam.durationMs) return `${Math.round(exam.durationMs / 60000)} 分钟`;
  if (exam.module === "listening") return "约 30 分钟";
  return exam.module === "writing" || exam.module === "reading" ? "60 分钟" : "—";
}

export function statusLabel(status: SessionSummary["status"]) {
  return ({ submitted: "已完成", in_progress: "进行中", interrupted: "已中断", created: "已创建", aborted: "已终止" } as const)[status];
}

export function formatDate(value: string) {
  return value.replace("T", " ").slice(0, 16);
}

export function formatAns(value: unknown): string {
  if (value == null || value === "") return "—";
  return Array.isArray(value) ? value.join(", ") : String(value);
}

export function formatDay(value: Date) {
  return `${value.getMonth() + 1} 月 ${value.getDate()} 日`;
}

export function rangeLabel(rangeDays: number) {
  if (rangeDays === 0) return "全部记录";
  if (rangeDays === 365) return "过去一年";
  return `过去 ${rangeDays} 天`;
}

/** Local Monday 00:00 of the week containing `now`, as epoch milliseconds. */
export function startOfWeek(now: Date) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekday = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - weekday);
  return d.getTime();
}

/** Whole days from today to `date` (YYYY-MM-DD); negative once it has passed. */
export function daysUntil(date?: string) {
  if (!date) return null;
  const target = Date.parse(`${date}T00:00:00`);
  if (!Number.isFinite(target)) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((target - today) / 86400000);
}

/**
 * How far through a paper a session got, 0-1, or null when the summary
 * predates the answered/total fields.
 */
export function completion(session: SessionSummary): number | null {
  if (typeof session.answered !== "number" || typeof session.total !== "number") return null;
  if (session.total <= 0) return null;
  return Math.min(1, session.answered / session.total);
}

/**
 * Whether a session counts as a finished paper.
 *
 * Submitting is not finishing. The bar is deliberately "attempted essentially
 * all of it" rather than a soft percentage: a learner who left half the paper
 * blank has not done that paper, and telling them otherwise makes the weekly
 * count useless. Sessions with no progress data recorded fall back to their
 * status so old records do not silently vanish from the count.
 */
export const FINISHED_RATIO = 0.9;

export function isFinished(session: SessionSummary): boolean {
  if (session.status !== "submitted") return false;
  const ratio = completion(session);
  return ratio === null ? true : ratio >= FINISHED_RATIO;
}
