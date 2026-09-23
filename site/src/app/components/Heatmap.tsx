/**
 * GitHub-style contribution heatmap, Monday-first, covering the last ~20
 * weeks. The metric is honest and stated under the chart: questions answered
 * per local day — `session.answered` summed over the sessions updated that
 * day. A day with sessions but no `answered` field (older records) falls back
 * to the session count so it still registers; a day with nothing stays empty.
 * Pure render — the parent feeds `listSessions()` in, no fetching here.
 */
import { useMemo, useState } from "react";
import type { SessionSummary } from "../types";
import { localDayKey, localDayOf } from "../lib/today";

const WEEKS = 20;
const CELL = 11;
const GAP = 3;
const LEFT = 16; // room for the weekday labels
const TOP = 14; // room for the month labels
/** fillOpacity of var(--accent) per level; level 0 is the empty cell. */
const LEVEL_OPACITY = [0, 0.3, 0.55, 0.8, 1];
const DAY_MS = 24 * 60 * 60 * 1000;

interface DayStat {
  answered: number;
  sessions: number;
}

interface Cell {
  key: string;
  x: number;
  y: number;
  /** Grid row 0–6 (Mon–Sun); top rows flip the tooltip below the cell. */
  row: number;
  level: number;
  title: string;
}

interface Tip {
  left: number;
  top: number;
  below: boolean;
  text: string;
}

/** Fixed buckets, not quartiles: level 4 means a full 40-question paper's worth. */
function intensity(stat: DayStat | undefined): number {
  if (!stat) return 0;
  const value = stat.answered > 0 ? stat.answered : stat.sessions;
  if (value <= 0) return 0;
  if (value < 10) return 1;
  if (value < 20) return 2;
  if (value < 40) return 3;
  return 4;
}

export default function Heatmap({ sessions }: { sessions: SessionSummary[] }) {
  const [tip, setTip] = useState<Tip | null>(null);

  const { cells, months, summary, width, height } = useMemo(() => {
    const byDay = new Map<string, DayStat>();
    for (const s of sessions) {
      const key = localDayKey(s.updatedAt ?? s.startedAt);
      if (!key) continue;
      const entry = byDay.get(key) ?? { answered: 0, sessions: 0 };
      entry.sessions += 1;
      entry.answered += typeof s.answered === "number" ? s.answered : 0;
      byDay.set(key, entry);
    }

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    // Columns are Monday-anchored weeks; the current week is the last column.
    const mondayOffset = (today.getDay() + 6) % 7;
    const start = new Date(today);
    start.setDate(start.getDate() - mondayOffset - (WEEKS - 1) * 7);
    const startKey = localDayOf(start);
    const todayKey = localDayOf(today);

    const cells: Cell[] = [];
    const months: { x: number; label: string }[] = [];
    let lastLabelWeek = -2; // the first column is always allowed a label
    let activeDays = 0;
    let totalAnswered = 0;

    for (let w = 0; w < WEEKS; w += 1) {
      const monday = new Date(start);
      monday.setDate(monday.getDate() + w * 7);
      /* 月份标签落在「包含该月 1 号」的那一列（GitHub 同款规则）；相邻标签
         至少隔一列，防止「11月」「12月」贴在一起。 */
      for (let r = 0; r < 7; r += 1) {
        const day = new Date(monday);
        day.setDate(day.getDate() + r);
        if (day.getTime() > today.getTime()) break;
        if (day.getDate() === 1 && w - lastLabelWeek >= 2) {
          months.push({ x: LEFT + w * (CELL + GAP), label: `${day.getMonth() + 1}月` });
          lastLabelWeek = w;
          break;
        }
      }
      for (let r = 0; r < 7; r += 1) {
        const day = new Date(monday);
        day.setDate(day.getDate() + r);
        if (day.getTime() > today.getTime()) continue; // future cells stay blank
        const key = localDayOf(day);
        const stat = byDay.get(key);
        const level = intensity(stat);
        if (level > 0) activeDays += 1;
        if (stat) totalAnswered += stat.answered;
        const dateLabel = `${day.getMonth() + 1}月${day.getDate()}日`;
        const title = !stat
          ? `${dateLabel} · 无记录`
          : stat.answered > 0
            ? `${dateLabel} · ${stat.answered} 题`
            : `${dateLabel} · ${stat.sessions} 次练习`;
        cells.push({
          key,
          x: LEFT + w * (CELL + GAP),
          y: TOP + r * (CELL + GAP),
          row: r,
          level,
          title,
        });
      }
    }

    /* 窗口若从月中开始，第一个标签列之前的日子属于上一段月份 —— 在第 0 列
       补一个起始月标签，前提是离首个标签还有至少两列空位，否则会叠字。 */
    if (
      months.length === 0 ||
      (months[0].x - LEFT >= (CELL + GAP) * 2 && months[0].label !== `${start.getMonth() + 1}月`)
    ) {
      months.unshift({ x: LEFT, label: `${start.getMonth() + 1}月` });
    }

    /* 底部统计只数窗口内的日子：有记录天数、累计答题数、最长连续天数。
       连续按日历日判定（排序后的 key 差一天），不是连续有会话。 */
    const activeKeys = [...byDay.keys()].filter((k) => k >= startKey && k <= todayKey).sort();
    let longest = 0;
    let run = 0;
    let prev = -1;
    for (const k of activeKeys) {
      const [y, m, d] = k.split("-").map(Number);
      const t = new Date(y, m - 1, d).getTime();
      run = t - prev === DAY_MS ? run + 1 : 1;
      if (run > longest) longest = run;
      prev = t;
    }

    return {
      cells,
      months,
      summary: { activeDays, totalAnswered, longest },
      width: LEFT + WEEKS * (CELL + GAP) - GAP,
      height: TOP + 7 * (CELL + GAP) - GAP,
    };
  }, [sessions]);

  const weekdayLabels = ["一", "三", "五"]; // Mon / Wed / Fri rows

  const showTip = (c: Cell) => {
    const below = c.row < 2; // 顶部两行反过来往 cell 下方挂，避免被滚动容器裁掉
    setTip({
      left: Math.min(Math.max(c.x + CELL / 2, 72), width - 72),
      top: below ? c.y + CELL + 7 : c.y - 7,
      below,
      text: c.title,
    });
  };

  return (
    <div className="heatmap-scroll">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="学习热力图"
        style={{ display: "block", maxWidth: "none" }}
      >
        {months.map((m) => (
          <text key={`${m.x}-${m.label}`} x={m.x} y={9.5} fontSize={9.5} fill="var(--muted)">
            {m.label}
          </text>
        ))}
        {weekdayLabels.map((label, i) => (
          <text
            key={label}
            x={0}
            y={TOP + i * 2 * (CELL + GAP) + CELL - 2}
            fontSize={9}
            fill="var(--muted)"
          >
            {label}
          </text>
        ))}
        {cells.map((c) => (
          <rect
            key={c.key}
            className={`heatmap-cell${c.level === 0 ? " empty" : ""}`}
            x={c.x}
            y={c.y}
            width={CELL}
            height={CELL}
            rx={2.5}
            fill={c.level === 0 ? "var(--panel-2)" : "var(--accent)"}
            fillOpacity={c.level === 0 ? 1 : LEVEL_OPACITY[c.level]}
            onMouseEnter={() => showTip(c)}
            onMouseLeave={() => setTip(null)}
          >
            <title>{c.title}</title>
          </rect>
        ))}
      </svg>
      {tip && (
        <div
          className={`heatmap-tip${tip.below ? " below" : ""}`}
          role="tooltip"
          style={{ left: tip.left, top: tip.top }}
        >
          {tip.text}
        </div>
      )}
      <div className="heatmap-foot">
        <span className="heatmap-stats">
          {summary.activeDays === 0
            ? "近 20 周还没有学习记录"
            : `近 20 周 · ${summary.activeDays} 天有记录 · 答题 ${summary.totalAnswered} 题 · 最长连续 ${summary.longest} 天`}
        </span>
        <span className="heatmap-legend" aria-hidden="true">
          <span>少</span>
          {LEVEL_OPACITY.map((opacity, i) => (
            <span
              key={i}
              style={{
                width: 10,
                height: 10,
                borderRadius: 2.5,
                display: "inline-block",
                background: i === 0 ? "var(--panel-2)" : "var(--accent)",
                opacity: i === 0 ? 1 : opacity,
                boxShadow: i === 0 ? "inset 0 0 0 1px var(--line)" : undefined,
              }}
            />
          ))}
          <span>多</span>
        </span>
      </div>
    </div>
  );
}
