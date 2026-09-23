/**
 * 题库行：一条卷一行，信息密度对齐虾滑/ZYZ——标题行是「剑18 · Test 2 · 阅读」，
 * meta 行是「P1–P3 · 40 题 · 高频 · 配对/TFNG · 未练」，做过的卷再补一行
 * 「上次 9/13 · 模考 · 对 31/40 · 用时 54m12s」。所有数字都来自 session 或
 * scoreExam 现算，没有就干脆不显示。
 */
import { formatDate } from "../lib/format";
import type { IndexedExam } from "../content";
import type { Session } from "../types";

/* --------------------------------------------------------- per-exam state */

export interface ExamActivity {
  /** 最新可恢复会话（created / in_progress / interrupted）。 */
  open?: Session;
  /** 最近一次已提交会话。 */
  lastSubmitted?: Session;
  /** 任意会话的最近 updatedAt，用于「最近做过」排序。 */
  lastActivity?: string;
  submittedCount: number;
}

export type ExamStatus = "none" | "open" | "done";

export function activityByExam(sessions: Session[]): Map<string, ExamActivity> {
  const map = new Map<string, ExamActivity>();
  for (const s of sessions) {
    const entry = map.get(s.examId) ?? { submittedCount: 0 };
    if (s.status === "submitted") {
      entry.submittedCount += 1;
      if (!entry.lastSubmitted || s.updatedAt > entry.lastSubmitted.updatedAt) {
        entry.lastSubmitted = s;
      }
    }
    if (
      (s.status === "in_progress" || s.status === "created" || s.status === "interrupted") &&
      (!entry.open || s.updatedAt > entry.open.updatedAt)
    ) {
      entry.open = s;
    }
    if (!entry.lastActivity || s.updatedAt > entry.lastActivity) {
      entry.lastActivity = s.updatedAt;
    }
    map.set(s.examId, entry);
  }
  return map;
}

export function activityStatus(activity: ExamActivity | undefined): ExamStatus {
  if (activity?.open) return "open";
  if (activity && activity.submittedCount > 0) return "done";
  return "none";
}

export function answeredCount(session: Session): number {
  return Object.values(session.answers ?? {}).filter(
    (a) => a.value != null && a.value !== "" && !(Array.isArray(a.value) && a.value.length === 0),
  ).length;
}

/* ------------------------------------------------------------- labels */

const TYPE_SHORT: Record<string, string> = {
  single_choice: "单选",
  multi_choice: "多选",
  true_false_ng: "T/F/NG",
  yes_no_ng: "Y/N/NG",
  completion: "填空",
  matching: "配对",
  labelling: "标注",
};

export function questionTypeShort(type: string): string {
  return TYPE_SHORT[type] ?? type.replaceAll("_", " ");
}

export const FREQUENCY_LABEL: Record<string, string> = {
  high: "高频",
  mid: "中频",
  low: "低频",
  normal: "常规",
};

export const DIFFICULTY_LABEL: Record<string, string> = {
  easy: "偏易",
  medium: "中等",
  hard: "偏难",
};

export const STATUS_LABEL: Record<ExamStatus, string> = {
  none: "未练",
  open: "进行中",
  done: "已练",
};

const STATUS_COLOR: Record<ExamStatus, string> = {
  none: "var(--muted)",
  open: "var(--caution)",
  done: "var(--positive)",
};

/** 「剑18 · Test 2 · 听力」；非剑桥卷用原标题。 */
export function examLineTitle(exam: IndexedExam): string {
  if (exam.book != null && exam.test != null) {
    return `剑${exam.book} · Test ${exam.test} · ${moduleText(exam.module)}`;
  }
  return exam.title;
}

export function moduleText(module: IndexedExam["module"]): string {
  return ({ listening: "听力", reading: "阅读", writing: "写作", speaking: "口语" } as const)[module];
}

const GENERIC_PART = /^(section|part|passage|reading passage|writing task)\s*\d+\s*$/i;

/**
 * 部分标签压缩成「P1–P3」式区间（按位置编号，忽略源数据里个别写错的标题，
 * 如剑18T2 第三篇误标成 "Reading Passage 1"）；非标名（官方样题、自组卷）
 * 原样拼接。
 */
export function partRangeLabel(exam: IndexedExam): string {
  const labels = exam.partLabels ?? [];
  if (!labels.length) return "";
  if (labels.every((t) => GENERIC_PART.test(t.trim()))) {
    if (exam.module === "writing") {
      return labels.map((_, i) => `Task ${i + 1}`).join(" · ");
    }
    return labels.length === 1 ? "P1" : `P1–P${labels.length}`;
  }
  return labels.join(" · ");
}

function shortDay(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso.slice(0, 10);
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function durationText(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m >= 60) return `${Math.floor(m / 60)}h${m % 60}m`;
  return `${m}m${String(s).padStart(2, "0")}s`;
}

/**
 * 「用时」口径：fixed_duration 卷用 考试时长 - remainingMs（交卷时的考试钟），
 * 最能反映真实作答耗时；听力等 media_driven 卷回退到开始-提交墙钟，
 * 超过 4 小时（跨天续做的练习）就不显示，避免唬人数字。
 */
export function sessionDurationMs(exam: IndexedExam, session: Session): number | null {
  const limit = exam.durationMs;
  if (
    limit != null &&
    Number.isFinite(session.remainingMs) &&
    session.remainingMs >= 0 &&
    session.remainingMs <= limit
  ) {
    return limit - session.remainingMs;
  }
  const wall = Date.parse(session.updatedAt) - Date.parse(session.startedAt);
  return Number.isFinite(wall) && wall >= 0 && wall <= 4 * 3_600_000 ? wall : null;
}

/* ------------------------------------------------------------------- row */

export interface LastScore {
  correct: number;
  total: number;
}

export function LibraryRow({
  exam,
  activity,
  score,
  scorePending,
  weakMatches,
  onStart,
  onContinue,
}: {
  exam: IndexedExam;
  activity: ExamActivity | undefined;
  /** 最近一次提交的成绩；undefined 表示该卷没有可评分的提交。 */
  score: LastScore | null | undefined;
  scorePending: boolean;
  weakMatches: string[];
  onStart: (mode: "practice" | "mock") => void;
  onContinue: (session: Session) => void;
}) {
  const status = activityStatus(activity);
  const parts = partRangeLabel(exam);
  const types = (exam.questionTypes ?? []).map(questionTypeShort).join("/");
  const count =
    exam.module === "writing"
      ? `${exam.partLabels?.length ?? 0} 个任务`
      : `${exam.questionCount} 题`;

  const metaBits = [
    parts,
    count,
    exam.meta?.frequency ? FREQUENCY_LABEL[exam.meta.frequency] ?? exam.meta.frequency : "",
    exam.meta?.difficulty ? DIFFICULTY_LABEL[exam.meta.difficulty] ?? exam.meta.difficulty : "",
    types,
  ].filter(Boolean);

  const open = activity?.open;
  const last = activity?.lastSubmitted;
  const dur = last ? sessionDurationMs(exam, last) : null;

  return (
    <article
      className="catalog-row"
      style={{ gridTemplateColumns: "minmax(0, 1fr) auto", alignItems: "center" }}
    >
      <div className="catalog-title" style={{ minWidth: 0 }}>
        <h3 title={exam.title}>
          {examLineTitle(exam)}
          {weakMatches.length > 0 && (
            <span
              className="mode-label"
              style={{ marginLeft: 8 }}
              title={`近 30 天正确率低于 60% 的题型：${weakMatches.join("、")}`}
            >
              含薄弱题型
            </span>
          )}
          {exam.module === "listening" && exam.audioStatus === "missing" && (
            <span
              className="catalog-mod locked"
              style={{ marginLeft: 8, verticalAlign: "1px" }}
              title="该卷音频暂不可用"
            >
              音频未就绪
            </span>
          )}
        </h3>
        <small>
          {metaBits.join(" · ")}
          {metaBits.length > 0 && " · "}
          <b style={{ color: STATUS_COLOR[status], fontWeight: 600 }}>{STATUS_LABEL[status]}</b>
        </small>
        {open ? (
          <small style={{ display: "block", marginTop: 3, color: "var(--muted)" }}>
            进行中 · {open.mode === "mock" ? "模考" : "练习"} · 已答 {answeredCount(open)}/
            {exam.questionCount || "?"} · {formatDate(open.updatedAt)} 更新
          </small>
        ) : last ? (
          <small style={{ display: "block", marginTop: 3, color: "var(--muted)" }}>
            上次 {shortDay(last.updatedAt)} · {last.mode === "mock" ? "模考" : "练习"}
            {exam.module === "writing"
              ? " · 已提交"
              : scorePending
                ? " · 评分中…"
                : score
                  ? ` · 对 ${score.correct}/${score.total}`
                  : ""}
            {dur != null ? ` · 用时 ${durationText(dur)}` : ""}
          </small>
        ) : null}
      </div>
      <div className="catalog-actions">
        {open && (
          <button type="button" className="strict-button" onClick={() => onContinue(open)}>
            继续
          </button>
        )}
        <button type="button" className="module-button" onClick={() => onStart("mock")}>
          模考
        </button>
        <button type="button" className="module-button" onClick={() => onStart("practice")}>
          练习
        </button>
      </div>
    </article>
  );
}
