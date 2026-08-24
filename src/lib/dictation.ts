/**
 * Word-level diff for the intensive-listening dictation.
 *
 * What matters to a learner is *which* words they missed, not an edit distance.
 * So this is a plain LCS diff over normalised words, reported as a list of
 * runs the UI can colour: `same`, `missing` (in the transcript, not typed) and
 * `extra` (typed, not in the transcript).
 */

export type DiffKind = "same" | "missing" | "extra";

export interface DiffRun {
  kind: DiffKind;
  words: string[];
}

/** Words as compared: punctuation and case do not count as mistakes. */
export function words(text: string): string[] {
  return text
    .replace(/[‘’]/g, "'")
    .split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, ""))
    .filter(Boolean);
}

function key(word: string) {
  return word.toLowerCase().replace(/'/g, "");
}

/** Longest common subsequence table over two word lists. */
function lcs(a: string[], b: string[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = key(a[i]) === key(b[j])
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}

export function diffWords(expected: string, typed: string): DiffRun[] {
  const a = words(expected);
  const b = words(typed);
  const table = lcs(a, b);
  const runs: DiffRun[] = [];
  const push = (kind: DiffKind, word: string) => {
    const last = runs[runs.length - 1];
    if (last && last.kind === kind) last.words.push(word);
    else runs.push({ kind, words: [word] });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (key(a[i]) === key(b[j])) {
      push("same", a[i]);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      push("missing", a[i]);
      i += 1;
    } else {
      push("extra", b[j]);
      j += 1;
    }
  }
  while (i < a.length) { push("missing", a[i]); i += 1; }
  while (j < b.length) { push("extra", b[j]); j += 1; }
  return runs;
}

/** Share of transcript words the learner typed correctly, 0-1. */
export function accuracy(expected: string, typed: string): number {
  const total = words(expected).length;
  if (!total) return 0;
  const same = diffWords(expected, typed)
    .filter((run) => run.kind === "same")
    .reduce((sum, run) => sum + run.words.length, 0);
  return same / total;
}
