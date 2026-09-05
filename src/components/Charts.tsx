import { Icon, type IconName } from "./Ui";
import { rawNeededForBand, rawToBand } from "../lib/band";
import type { AnalyticsPoint, ModuleKind } from "../lib/types";

/** `ratio` is only ever a real measured percentage; omit it rather than invent one. */
export function WeeklyStat({ icon, label, value, ratio, hint }: { icon: IconName; label: string; value: string; ratio?: number; hint?: string }) {
  return <div className="weekly-stat"><div><span className="stat-icon"><Icon name={icon} /></span><strong>{label}</strong><b>{value}</b></div>{ratio == null ? null : <i><span style={{ width: `${Math.max(0, Math.min(100, ratio))}%` }} /></i>}{hint && <em>{hint}</em>}</div>;
}

/**
 * Plots estimated bands. Points whose raw score falls below the conversion
 * table carry `band: null` and are skipped — never back-filled with a formula.
 */
export function MiniTrend({ points, large = false }: { points: AnalyticsPoint[]; large?: boolean }) {
  const values = points.map((p) => p.band ?? (p.module && p.rawCorrect != null ? rawToBand(p.module, p.rawCorrect) : null)).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (!values.length) return <div className={`trend-empty ${large ? "large" : ""}`}>完成考试后显示真实趋势</div>;
  const min = Math.min(...values, 4); const max = Math.max(...values, 9); const width = 360; const height = large ? 150 : 86;
  const coords = values.map((v, i) => ({ x: (i / Math.max(1, values.length - 1)) * width, y: height - ((v - min) / Math.max(1, max - min)) * (height - 14) - 7 })); const path = coords.map(({ x, y }) => `${x},${y}`).join(" ");
  return <svg className={`mini-trend ${large ? "large" : ""}`} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="真实成绩趋势"><defs><linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--accent)" stopOpacity=".22"/><stop offset="1" stopColor="var(--accent)" stopOpacity="0"/></linearGradient></defs><polygon points={`0,${height} ${path} ${width},${height}`} fill="url(#trendFill)"/><polyline points={path} fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />{coords.map(({ x, y }, i) => <circle key={i} cx={x} cy={y} r="3.5" fill="var(--panel)" stroke="var(--accent)" strokeWidth="2" />)}</svg>;
}

/** Estimated band beside the raw score, always with the "not official" caveat. */
export function BandEstimate({ module, raw, total, target }: { module: ModuleKind; raw: number; total: number; target?: number }) {
  const band = rawToBand(module, raw);
  const needed = target == null ? null : rawNeededForBand(module, target);
  const gap = needed == null ? null : needed - raw;
  return <div className="band-estimate">
    <div className="band-value"><small>估算 Band</small><strong>{band == null ? "—" : band.toFixed(1)}</strong></div>
    <p className="band-caveat">非官方成绩。按 <code>schema/band-conversion.json</code> 的近似换算表估算，真实考试以官方评分为准。{band == null && " 本次原始分低于换算表下限，无法给出估算。"}</p>
    {target != null && (needed == null
      ? <p className="band-gap">目标 {target.toFixed(1)} 分不在本模块的换算表范围内。</p>
      : gap != null && gap <= 0
        ? <p className="band-gap ok"><Icon name="check" size={15} />已达到目标 {target.toFixed(1)} 分。</p>
        : <p className="band-gap">距目标 {target.toFixed(1)} 分还差 <strong>{gap}</strong> 题（需答对 {needed}/{total}）。</p>)}
  </div>;
}
