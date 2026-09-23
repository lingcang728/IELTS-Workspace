/**
 * FSRS-4.5 scheduling — TypeScript port of `src-tauri/src/srs.rs`.
 * Same published default weights, same equations; do not "simplify" these.
 */
export type Grade = 1 | 2 | 3 | 4;

export interface Memory {
  stability: number;
  difficulty: number;
}

const W = [
  0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031, 1.6474, 0.1367, 1.0461,
  2.1072, 0.0793, 0.3246, 1.587, 0.2272, 2.8755,
] as const;

const DECAY = -0.5;
const FACTOR = 19 / 81;
const MIN_STABILITY = 0.1;
const MAX_STABILITY = 36500;

export function retrievability(stability: number, elapsedDays: number): number {
  return Math.pow(1 + (FACTOR * Math.max(0, elapsedDays)) / Math.max(MIN_STABILITY, stability), DECAY);
}

export function intervalDays(stability: number, requestedRetention: number): number {
  const retention = Math.min(0.99, Math.max(0.7, requestedRetention));
  return (stability / FACTOR) * (Math.pow(retention, 1 / DECAY) - 1);
}

const clampDifficulty = (d: number) => Math.min(10, Math.max(1, d));
const clampStability = (s: number) => Math.min(MAX_STABILITY, Math.max(MIN_STABILITY, s));

export function initial(grade: Grade): Memory {
  const index = grade - 1;
  return {
    stability: clampStability(W[index]),
    difficulty: clampDifficulty(W[4] - Math.exp(W[5] * (grade - 3)) + 1),
  };
}

function nextDifficulty(difficulty: number, grade: Grade): number {
  const delta = difficulty - W[6] * (grade - 3);
  const target = initial(4).difficulty;
  return clampDifficulty(W[7] * target + (1 - W[7]) * delta);
}

function stabilityAfterRecall(memory: Memory, r: number, grade: Grade): number {
  const hardPenalty = grade === 2 ? W[15] : 1;
  const easyBonus = grade === 4 ? W[16] : 1;
  const growth =
    Math.exp(W[8]) *
    (11 - memory.difficulty) *
    Math.pow(memory.stability, -W[9]) *
    Math.expm1(W[10] * (1 - r)) *
    hardPenalty *
    easyBonus;
  return clampStability(memory.stability * (1 + growth));
}

function stabilityAfterLapse(memory: Memory, r: number): number {
  const value =
    W[11] *
    Math.pow(memory.difficulty, -W[12]) *
    (Math.pow(memory.stability + 1, W[13]) - 1) *
    Math.exp(W[14] * (1 - r));
  return clampStability(Math.min(value, memory.stability));
}

export function review(previous: Memory | undefined, elapsedDays: number, grade: Grade): Memory {
  if (!previous) return initial(grade);
  const r = retrievability(previous.stability, elapsedDays);
  return {
    difficulty: nextDifficulty(previous.difficulty, grade),
    stability: grade === 1 ? stabilityAfterLapse(previous, r) : stabilityAfterRecall(previous, r, grade),
  };
}
