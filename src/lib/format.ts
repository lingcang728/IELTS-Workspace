/** Display formatting shared across the shell pages. No React, no side effects. */
import type { ExamSummary, SessionSummary } from "./types";

export function sourceLabel(exam: ExamSummary) {
  if (exam.source?.kind === "official_sample") return "IELTS Official";
  if (exam.source?.kind === "cambridge_book") return exam.source.title || exam.source.publisher || "Cambridge IELTS";
  if (exam.source?.kind === "imported_document") return exam.source.title || "本地导入";
  return exam.source?.title || "本地题库";
}

export function moduleLabel(module: ExamSummary["module"]) {
  return module[0].toUpperCase() + module.slice(1);
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
