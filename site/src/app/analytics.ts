/**
 * Port of `analytics_report_inner` (src-tauri/src/commands.rs). The report is
 * a pure function of submitted sessions + current answer keys: every session
 * is re-scored against today's exam JSON, never trusting a stored score.
 */
import { idbAll } from "./idb";
import { loadExam } from "./content";
import { scoreExam } from "./scoring";
import { rawToBand } from "./lib/band";
import type { AnalyticsPoint, AnalyticsReport, ModuleKind, Session } from "./types";

const epochDayNow = () => Math.floor(Date.now() / 86_400_000);
const isoEpochDay = (iso?: string) => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor(t / 86_400_000) : null;
};

export async function analyticsReport(rangeDays = 30): Promise<AnalyticsReport> {
  const cutoffDay = rangeDays === 0 ? null : epochDayNow() - (rangeDays - 1);

  const moduleScores = new Map<string, number[]>();
  const moduleCounts = new Map<string, number>();
  const unbandedCounts = new Map<string, number>();
  const trend = new Map<string, AnalyticsPoint[]>();
  const typeTotals = new Map<string, { correct: number; total: number }>();
  const timeTrend: AnalyticsPoint[] = [];

  const sessions = await idbAll<Session>("sessions");
  for (const session of sessions) {
    if (session.status !== "submitted") continue;
    const module = (session.module ?? "writing") as ModuleKind;
    const updated = session.updatedAt ?? "";
    if (cutoffDay != null) {
      const day = isoEpochDay(updated);
      if (day != null && day < cutoffDay) continue;
    }
    moduleCounts.set(module, (moduleCounts.get(module) ?? 0) + 1);
    if (module === "writing" || module === "speaking") continue;

    let exam;
    try {
      exam = await loadExam(session.examId);
    } catch {
      continue;
    }
    const answers: Record<string, unknown> = {};
    for (const [qid, entry] of Object.entries(session.answers ?? {})) {
      answers[qid] = entry;
    }
    const score = scoreExam(exam, answers);
    const band = rawToBand(module, score.rawCorrect);
    if (band == null) {
      unbandedCounts.set(module, (unbandedCounts.get(module) ?? 0) + 1);
    } else {
      const list = moduleScores.get(module) ?? [];
      list.push(band);
      moduleScores.set(module, list);
    }
    const point: AnalyticsPoint = {
      date: updated,
      band,
      rawCorrect: score.rawCorrect,
      rawTotal: score.rawTotal,
    };
    trend.set(module, [...(trend.get(module) ?? []), point]);
    timeTrend.push({ ...point, module });
    for (const item of score.questions) {
      const key = `${module}::${item.questionType}`;
      const totals = typeTotals.get(key) ?? { correct: 0, total: 0 };
      totals.total += 1;
      if (item.correct) totals.correct += 1;
      typeTotals.set(key, totals);
    }
  }

  const moduleAverages: AnalyticsReport["moduleAverages"] = {};
  let sum = 0;
  let count = 0;
  for (const [module, scores] of moduleScores) {
    if (!scores.length) continue;
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    moduleAverages[module as ModuleKind] = avg;
    sum += avg;
    count += 1;
  }

  const toRecord = (m: Map<string, number>) =>
    Object.fromEntries(m) as Partial<Record<ModuleKind, number>>;

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    rangeDays,
    overallAverage: count === 0 ? undefined : sum / count,
    moduleAverages,
    moduleCounts: toRecord(moduleCounts),
    unbandedCounts: toRecord(unbandedCounts),
    scoreTrend: Object.fromEntries(trend) as AnalyticsReport["scoreTrend"],
    questionTypeAccuracy: [...typeTotals.entries()].map(([key, t]) => {
      const [module, questionType] = key.split("::");
      return {
        module: module as "reading" | "listening",
        questionType,
        correct: t.correct,
        total: t.total,
        accuracy: t.total === 0 ? 0 : t.correct / t.total,
      };
    }),
    timeTrend,
    speakingEnabled: false,
  };
}
