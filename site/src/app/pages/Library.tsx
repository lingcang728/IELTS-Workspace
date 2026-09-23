/**
 * 题库页：像虾滑/ZYZ 一样，一眼看出「练哪篇最值」。
 *
 * 顶部模块切换（听力/阅读/写作）+ 横向筛选（册别/题型/频次/难度/状态/排序），
 * 行内信息全部是真实数据：状态来自 IndexedDB 会话，最近一次成绩用
 * scoreExam 按当前答案表现算，「含薄弱题型」来自近 30 天 analyticsReport
 * 里 accuracy<0.6 且 total>=5 的题型。没有数据的维度直接不渲染，
 * 筛选条件也只在真实存在该维度时才出现。
 *
 * 组卷模考见 lib/compose.ts 与 components/LibraryCompose.tsx。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { analyticsReport, listExams, scoreExam } from "../api";
import type { IndexedExam } from "../content";
import { idbAll } from "../idb";
import { questionTypeLabel } from "../lib/format";
import { navigate, type Route } from "../nav";
import type { Session } from "../types";
import { LibraryCompose } from "../components/LibraryCompose";
import {
  activityByExam,
  activityStatus,
  DIFFICULTY_LABEL,
  examLineTitle,
  FREQUENCY_LABEL,
  LibraryRow,
  moduleText,
  STATUS_LABEL,
  type ExamStatus,
  type LastScore,
} from "../components/LibraryRow";

type ModuleTab = "listening" | "reading" | "writing";

const MODULE_TABS: { id: ModuleTab; label: string }[] = [
  { id: "listening", label: "听力" },
  { id: "reading", label: "阅读" },
  { id: "writing", label: "写作" },
];

type StatusFilter = "all" | ExamStatus;
type SortKey = "smart" | "recent" | "book_desc" | "book_asc";

const EMPTY_TYPES: string[] = [];

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "smart", label: "推荐排序" },
  { value: "recent", label: "最近做过" },
  { value: "book_desc", label: "书号 新→旧" },
  { value: "book_asc", label: "书号 旧→新" },
];

function parseModule(raw: string | null): ModuleTab | null {
  return raw === "listening" || raw === "reading" || raw === "writing" ? raw : null;
}

function parseStatus(raw: string | null): StatusFilter {
  if (raw === "none" || raw === "unpractised" || raw === "todo") return "none";
  if (raw === "open" || raw === "doing" || raw === "in_progress") return "open";
  if (raw === "done" || raw === "finished" || raw === "submitted") return "done";
  return "all";
}

function matchesQuery(exam: IndexedExam, needle: string, compact: string): boolean {
  if (!needle) return true;
  const haystacks = [exam.title, exam.id, examLineTitle(exam)];
  if (exam.book != null) haystacks.push(`剑${exam.book}`, `剑 ${exam.book}`, `cambridge ${exam.book}`);
  if (exam.test != null) haystacks.push(`test ${exam.test}`, `t${exam.test}`);
  return haystacks.some((text) => {
    const lower = text.toLowerCase();
    return lower.includes(needle) || lower.replace(/\s+/g, "").includes(compact);
  });
}

export default function Library({ route }: { route: Route }) {
  const [exams, setExams] = useState<IndexedExam[] | null>(null);
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** module -> 近 30 天薄弱题型（accuracy<0.6 且 total>=5）。 */
  const [weakTypes, setWeakTypes] = useState<Map<string, string[]>>(new Map());

  const init = route.query;
  const [module, setModule] = useState<ModuleTab>(() => parseModule(init.get("module")) ?? "listening");
  const [book, setBook] = useState(init.get("book") ?? "all");
  const [type, setType] = useState(init.get("type") ?? "all");
  const [freq, setFreq] = useState(init.get("freq") ?? "all");
  const [diff, setDiff] = useState(init.get("diff") ?? "all");
  const [status, setStatus] = useState<StatusFilter>(() => parseStatus(init.get("status")));
  const [sort, setSort] = useState<SortKey>((init.get("sort") as SortKey) || "smart");
  const [search, setSearch] = useState(init.get("q") ?? "");
  const [composeOpen, setComposeOpen] = useState(false);

  // 页内再次跳到带筛选参数的 /app/library 时（如分析页链接），同步初始筛选。
  useEffect(() => {
    const q = route.query;
    const m = parseModule(q.get("module"));
    if (m) setModule(m);
    if (q.get("book")) setBook(q.get("book")!);
    if (q.get("type")) setType(q.get("type")!);
    if (q.get("freq")) setFreq(q.get("freq")!);
    if (q.get("diff")) setDiff(q.get("diff")!);
    if (q.get("status")) setStatus(parseStatus(q.get("status")));
    if (q.get("q") != null) setSearch(q.get("q") ?? "");
  }, [route.query]);

  /* ------------------------------------------------------------ data */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [examList, all] = await Promise.all([listExams(), idbAll<Session>("sessions")]);
        if (!alive) return;
        setExams(examList);
        setSessions(all.filter((s) => !(s as Session & { archived?: boolean }).archived));
      } catch (e) {
        if (alive) setLoadError(e instanceof Error ? e.message : "题库加载失败");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    analyticsReport(30)
      .then((report) => {
        if (!alive) return;
        const map = new Map<string, string[]>();
        for (const row of report.questionTypeAccuracy) {
          if (row.accuracy >= 0.6 || row.total < 5) continue;
          const list = map.get(row.module) ?? [];
          list.push(row.questionType);
          map.set(row.module, list);
        }
        setWeakTypes(map);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const activity = useMemo(() => activityByExam(sessions ?? []), [sessions]);
  const moduleExams = useMemo(
    () => (exams ?? []).filter((e) => e.module === module),
    [exams, module],
  );

  /* ----------------------------------------------------- filter options */
  const bookOptions = useMemo(() => {
    const books = [...new Set(moduleExams.map((e) => e.book).filter((b): b is number => b != null))].sort(
      (a, b) => b - a,
    );
    const kinds = new Set(moduleExams.map((e) => e.source?.kind));
    return {
      books,
      official: kinds.has("official_sample"),
      imported: kinds.has("imported_document"),
      other: moduleExams.some(
        (e) => e.book == null && e.source?.kind !== "official_sample" && e.source?.kind !== "imported_document",
      ),
    };
  }, [moduleExams]);

  const typeOptions = useMemo(() => {
    const set = new Set<string>();
    for (const e of moduleExams) for (const t of e.questionTypes ?? []) set.add(t);
    if (type !== "all") set.add(type); // 保留从外页跳入的初始值
    return [...set].sort((a, b) => questionTypeLabel(a).localeCompare(questionTypeLabel(b), "zh-Hans-CN"));
  }, [moduleExams, type]);

  const hasFrequency = moduleExams.some((e) => e.meta?.frequency != null);
  const hasDifficulty = moduleExams.some((e) => e.meta?.difficulty != null);
  const freqOptions = Object.keys(FREQUENCY_LABEL).filter(
    (f) => f === freq || moduleExams.some((e) => e.meta?.frequency === f),
  );
  const diffOptions = Object.keys(DIFFICULTY_LABEL).filter(
    (d) => d === diff || moduleExams.some((e) => e.meta?.difficulty === d),
  );

  /* --------------------------------------------------------- filtering */
  const needle = search.trim().toLowerCase();
  const compact = needle.replace(/\s+/g, "");
  const weakNow = useMemo(() => weakTypes.get(module) ?? EMPTY_TYPES, [weakTypes, module]);

  const visible = useMemo(() => {
    const matchBook = (e: IndexedExam): boolean => {
      if (book === "all") return true;
      if (book === "official") return e.source?.kind === "official_sample";
      if (book === "imported") return e.source?.kind === "imported_document";
      if (book === "other") {
        return (
          e.book == null &&
          e.source?.kind !== "official_sample" &&
          e.source?.kind !== "imported_document"
        );
      }
      return e.book === Number(book);
    };
    const statusOf = (e: IndexedExam) => activityStatus(activity.get(e.id));
    const weakHit = (e: IndexedExam) =>
      weakNow.some((t) => (e.questionTypes ?? []).includes(t));
    const byBook = (a: IndexedExam, b: IndexedExam) =>
      (b.book ?? -1) - (a.book ?? -1) ||
      (a.test ?? 0) - (b.test ?? 0) ||
      a.title.localeCompare(b.title, "zh-Hans-CN");
    const list = moduleExams.filter(
      (e) =>
        matchBook(e) &&
        (type === "all" || (e.questionTypes ?? []).includes(type)) &&
        (freq === "all" || e.meta?.frequency === freq) &&
        (diff === "all" || e.meta?.difficulty === diff) &&
        (status === "all" || statusOf(e) === status) &&
        matchesQuery(e, needle, compact),
    );
    if (sort === "recent") {
      list.sort(
        (a, b) =>
          (activity.get(b.id)?.lastActivity ?? "").localeCompare(
            activity.get(a.id)?.lastActivity ?? "",
          ) || byBook(a, b),
      );
    } else if (sort === "book_asc") {
      list.sort(
        (a, b) =>
          (a.book ?? 999) - (b.book ?? 999) ||
          (a.test ?? 0) - (b.test ?? 0) ||
          a.title.localeCompare(b.title, "zh-Hans-CN"),
      );
    } else if (sort === "book_desc") {
      list.sort(byBook);
    } else {
      // 推荐：未练在前，其中含薄弱题型的更靠前；书号新的在前。
      const rank = (e: IndexedExam) => {
        const s = statusOf(e);
        if (s === "none") return weakHit(e) ? 0 : 1;
        return s === "open" ? 2 : 3;
      };
      list.sort((a, b) => rank(a) - rank(b) || byBook(a, b));
    }
    return list;
  }, [moduleExams, book, type, freq, diff, status, sort, needle, compact, activity, weakNow]);

  /* ------------------------------------------------- latest-submitted 评分
   * 只对看得见的卷算分：scoreExam 要拉试卷 JSON，按当前答案键现算后缓存，
   * 没算完的行先显示「评分中…」。写作卷不参与（没有客观题）。 */
  const scoresRef = useRef(new Map<string, LastScore | null>());
  const scoringRef = useRef(new Set<string>());
  const [, setScoreTick] = useState(0);
  useEffect(() => {
    const pending: { examId: string; session: Session }[] = [];
    for (const e of visible) {
      if (e.module === "writing" || e.module === "speaking") continue;
      const last = activity.get(e.id)?.lastSubmitted;
      if (!last || scoresRef.current.has(e.id) || scoringRef.current.has(e.id)) continue;
      pending.push({ examId: e.id, session: last });
    }
    if (!pending.length) return;
    for (const p of pending) scoringRef.current.add(p.examId);
    let alive = true;
    (async () => {
      await Promise.all(
        pending.map(async ({ examId, session }) => {
          try {
            const report = await scoreExam(examId, session.answers);
            scoresRef.current.set(examId, { correct: report.rawCorrect, total: report.rawTotal });
          } catch {
            scoresRef.current.set(examId, null);
          } finally {
            scoringRef.current.delete(examId);
          }
        }),
      );
      if (alive) setScoreTick((t) => t + 1);
    })();
    return () => {
      alive = false;
    };
  }, [visible, activity]);

  /* ------------------------------------------------------------- render */
  const doneCount = moduleExams.filter((e) => activityStatus(activity.get(e.id)) === "done").length;
  const openCount = moduleExams.filter((e) => activityStatus(activity.get(e.id)) === "open").length;
  const filtersActive =
    book !== "all" || type !== "all" || freq !== "all" || diff !== "all" || status !== "all" || search !== "";
  const clearFilters = () => {
    setBook("all");
    setType("all");
    setFreq("all");
    setDiff("all");
    setStatus("all");
    setSearch("");
    setSort("smart");
  };

  const goExam = (examId: string, mode: "practice" | "mock", sessionId?: string) =>
    navigate("/app/exam", sessionId ? { exam: examId, mode, session: sessionId } : { exam: examId, mode });

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <span className="eyebrow">题库</span>
          <h1>练哪篇最值</h1>
          <p>
            {moduleExams.length} 套{moduleText(module)}卷 · 已练 {doneCount} · 进行中 {openCount}
            {weakNow.length > 0 && ` · 「含薄弱题型」按近 30 天正确率 <60% 标记`}
          </p>
        </div>
        {module !== "writing" && (
          <div style={{ alignSelf: "center" }}>
            <button
              type="button"
              className="primary-button"
              disabled={exams === null}
              onClick={() => setComposeOpen(true)}
            >
              组一套题
            </button>
          </div>
        )}
      </div>

      <section className="workspace-card" style={{ padding: "14px 18px" }}>
        <div className="catalog-toolbar" style={{ borderBottom: 0, paddingBottom: 10 }}>
          <div className="filter-tabs" role="tablist" aria-label="模块">
            {MODULE_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={module === tab.id}
                className={module === tab.id ? "active" : ""}
                onClick={() => setModule(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <label className="catalog-search">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索试卷（如 剑18 / test 2）"
            />
          </label>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <label className="select-field">
            <select value={book} onChange={(e) => setBook(e.target.value)} aria-label="册别">
              <option value="all">全部册别</option>
              {bookOptions.books.map((b) => (
                <option key={b} value={String(b)}>
                  剑桥 {b}
                </option>
              ))}
              {bookOptions.official && <option value="official">官方样题</option>}
              {bookOptions.imported && <option value="imported">自组卷</option>}
              {bookOptions.other && <option value="other">其他</option>}
            </select>
          </label>
          {typeOptions.length > 0 && (
            <label className="select-field">
              <select value={type} onChange={(e) => setType(e.target.value)} aria-label="题型">
                <option value="all">全部题型</option>
                {typeOptions.map((t) => (
                  <option key={t} value={t}>
                    {questionTypeLabel(t)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {hasFrequency && (
            <label className="select-field">
              <select value={freq} onChange={(e) => setFreq(e.target.value)} aria-label="频次">
                <option value="all">全部频次</option>
                {freqOptions.map((f) => (
                  <option key={f} value={f}>
                    {FREQUENCY_LABEL[f]}
                  </option>
                ))}
              </select>
            </label>
          )}
          {hasDifficulty && (
            <label className="select-field">
              <select value={diff} onChange={(e) => setDiff(e.target.value)} aria-label="难度">
                <option value="all">全部难度</option>
                {diffOptions.map((d) => (
                  <option key={d} value={d}>
                    {DIFFICULTY_LABEL[d]}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="filter-tabs" aria-label="状态">
            {(["all", "none", "open", "done"] as const).map((s) => (
              <button
                key={s}
                type="button"
                className={status === s ? "active" : ""}
                aria-pressed={status === s}
                onClick={() => setStatus(s)}
              >
                {s === "all" ? "全部状态" : STATUS_LABEL[s]}
              </button>
            ))}
          </div>
          <label className="select-field">
            <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="排序">
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          {filtersActive && (
            <button type="button" className="link-button" onClick={clearFilters}>
              清除筛选
            </button>
          )}
        </div>
      </section>

      <section className="workspace-card catalog-card">
        <div className="catalog-heading">
          <h2>{moduleText(module)}试卷</h2>
          <span>
            {visible.length} / {moduleExams.length} 套
          </span>
        </div>
        {loadError ? (
          <div className="empty-state compact">
            <h2>题库加载失败</h2>
            <p>{loadError}</p>
          </div>
        ) : exams === null || sessions === null ? (
          <div className="empty-state compact">
            <p>题库加载中…</p>
          </div>
        ) : moduleExams.length === 0 ? (
          <div className="empty-state compact">
            <h2>还没有{moduleText(module)}卷</h2>
            <p>题库索引里暂时没有{moduleText(module)}试卷。</p>
          </div>
        ) : visible.length === 0 ? (
          <div className="empty-state compact">
            <h2>没有符合筛选的试卷</h2>
            <p>当前筛选条件下没有结果，试试放宽条件。</p>
            <button type="button" className="secondary-button" onClick={clearFilters}>
              清除筛选
            </button>
          </div>
        ) : (
          <div className="catalog-list">
            {visible.map((exam) => {
              const act = activity.get(exam.id);
              const weak = weakNow.filter((t) => (exam.questionTypes ?? []).includes(t));
              const scorable = exam.module !== "writing" && exam.module !== "speaking";
              return (
                <LibraryRow
                  key={exam.id}
                  exam={exam}
                  activity={act}
                  score={scoresRef.current.get(exam.id)}
                  scorePending={scorable && !!act?.lastSubmitted && !scoresRef.current.has(exam.id)}
                  weakMatches={weak.map(questionTypeLabel)}
                  onStart={(mode) => goExam(exam.id, mode)}
                  onContinue={(s) => goExam(exam.id, s.mode, s.id)}
                />
              );
            })}
          </div>
        )}
      </section>

      {composeOpen && module !== "writing" && (
        <LibraryCompose
          module={module}
          exams={exams ?? []}
          activity={activity}
          onClose={() => setComposeOpen(false)}
        />
      )}
    </div>
  );
}
