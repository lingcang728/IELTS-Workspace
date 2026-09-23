/**
 * GitHub-style contribution heatmap, Monday-first, covering the last ~20
 * weeks. The metric is honest and stated under the chart: questions answered
 * per local day — `session.answered` summed over the sessions updated that
 * day. A day with sessions but no `answered` field (older records) falls back
 * to the session count so it still registers; a day with nothing stays empty.
 * Pure render — the parent feeds `listSessions()` in, no fetching here.
 */
import { useMemo } from "react";
import type { SessionSummary } from "../types";
import { localDayKey, localDayOf } from "../lib/today";

const WEEKS = 20;
const CELL = 11;
const GAP = 3;
const LEFT = 16; // room for the weekday labels
const TOP = 14; // room for the month labels
/** fillOpacity of var(--accent) per level; level 0 is the empty cell. */
const LEVEL_OPACITY = [0, 0.3, 0.55, 0.8, 1];

interface DayStat {
  answered: number;
  sessions: number;
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
  const { cells, months } = useMemo(() => {
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

    const cells: { key: string; x: number; y: number; level: number; title: string }[] = [];
    const months: { x: number; label: string }[] = [];
    let lastMonth = -1;
    for (let w = 0; w < WEEKS; w += 1) {
      const column = new Date(start);
      column.setDate(column.getDate() + w * 7);
      if (column.getMonth() !== lastMonth) {
        lastMonth = column.getMonth();
        months.push({ x: LEFT + w * (CELL + GAP), label: `${lastMonth + 1}月` });
      }
      for (let r = 0; r < 7; r += 1) {
        const day = new Date(column);
        day.setDate(day.getDate() + r);
        if (day.getTime() > today.getTime()) continue; // future cells stay blank
        const key = localDayOf(day);
        const stat = byDay.get(key);
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
          level: intensity(stat),
          title,
        });
      }
    }
    return { cells, months };
  }, [sessions]);

  const width = LEFT + WEEKS * (CELL + GAP) - GAP;
  const height = TOP + 7 * (CELL + GAP) - GAP;
  const weekdayLabels = ["一", "三", "五"]; // Mon / Wed / Fri rows

  return (
    <div style={{ overflowX: "auto", marginTop: 10 }}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="学习热力图"
        style={{ display: "block", maxWidth: "none" }}
      >
        {months.map((m) => (
          <text key={`${m.x}-${m.label}`} x={m.x} y={9} fontSize={9} fill="var(--muted)">
            {m.label}
          </text>
        ))}
        {weekdayLabels.map((label, i) => (
          <text
            key={label}
            x={0}
            y={TOP + i * 2 * (CELL + GAP) + CELL - 2}
            fontSize={8.5}
            fill="var(--muted)"
          >
            {label}
          </text>
        ))}
        {cells.map((c) => (
          <rect
            key={c.key}
            x={c.x}
            y={c.y}
            width={CELL}
            height={CELL}
            rx={2}
            fill={c.level === 0 ? "var(--panel-2)" : "var(--accent)"}
            fillOpacity={c.level === 0 ? 1 : LEVEL_OPACITY[c.level]}
          >
            <title>{c.title}</title>
          </rect>
        ))}
      </svg>
      <div
        className="meta"
        style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 4, marginTop: 6 }}
      >
        <span>少</span>
        {LEVEL_OPACITY.map((opacity, i) => (
          <span
            key={i}
            aria-hidden="true"
            style={{
              width: 10,
              height: 10,
              borderRadius: 2,
              display: "inline-block",
              background: i === 0 ? "var(--panel-2)" : "var(--accent)",
              opacity: i === 0 ? 1 : opacity,
            }}
          />
        ))}
        <span>多</span>
      </div>
    </div>
  );
}
