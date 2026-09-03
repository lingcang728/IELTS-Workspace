import table from "../../schema/band-conversion.json";

export type BandModule = "listening" | "reading";

export interface BandRow {
  min: number;
  max: number;
  band: number;
}

/**
 * The raw-to-band tables live in `schema/band-conversion.json` so the Rust
 * scorer (`src-tauri/src/band.rs`, via `include_str!`) and this module stay on
 * one set of numbers. Never inline a formula here — the mapping is a lookup
 * table, not `raw / total * 9`.
 */
const TABLES: Record<BandModule, BandRow[]> = {
  listening: table.listening as BandRow[],
  reading: table.readingAcademic as BandRow[],
};

export function bandTable(module: BandModule): BandRow[] {
  return TABLES[module];
}

/**
 * Estimated band for a raw score out of 40. Returns `null` when the raw score
 * falls below the published table (there is no honest band to report), and for
 * modules that have no objective raw score at all (writing / speaking).
 */
export function rawToBand(module: string, raw: number): number | null {
  const rows = TABLES[module as BandModule];
  if (!rows) return null;
  if (!Number.isFinite(raw)) return null;
  const score = Math.round(raw);
  for (const row of rows) {
    if (score >= row.min && score <= row.max) return row.band;
  }
  const top = rows[0];
  if (top && score > top.max) return top.band;
  return null;
}

/** Display helper: `7.0` / `—`. Never rendered without a "非官方" caveat. */
export function bandLabel(module: string, raw: number): string {
  const band = rawToBand(module, raw);
  return band == null ? "—" : band.toFixed(1);
}

/**
 * Smallest raw score that still reaches `target`, or `null` when the target is
 * outside the table. Used by the results page to say "距目标还差 N 题".
 */
export function rawNeededForBand(module: string, target: number): number | null {
  const rows = TABLES[module as BandModule];
  if (!rows || rows.length === 0) return null;
  if (!Number.isFinite(target)) return null;
  const lowestBand = rows[rows.length - 1].band;
  const highestBand = rows[0].band;
  if (target < lowestBand || target > highestBand) return null;
  let best: number | null = null;
  for (const row of rows) {
    if (row.band >= target) best = best == null ? row.min : Math.min(best, row.min);
  }
  return best;
}

