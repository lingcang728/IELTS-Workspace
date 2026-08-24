/**
 * The quote on the workbench.
 *
 * Each quote is split into three parts so the middle one can be marked with a
 * highlighter: the app's own gesture, turned on the encouragement. That is
 * where the colour comes from — not from tinting the card, which would just be
 * decoration, but from the one phrase actually worth taking away.
 *
 * The quote rotates by date so it is stable all day and different tomorrow.
 */

export interface Quote {
  before: string;
  /** The phrase under the highlighter. */
  mark: string;
  after: string;
  author: string;
  /** 1-4, matching the `--marker-N` tokens. */
  marker: 1 | 2 | 3 | 4;
}

export const QUOTES: Quote[] = [
  {
    before: "Success is the sum of ",
    mark: "small efforts",
    after: ", repeated day in and day out.",
    author: "Robert Collier",
    marker: 1,
  },
  {
    before: "It always seems ",
    mark: "impossible",
    after: " until it's done.",
    author: "Nelson Mandela",
    marker: 3,
  },
  {
    before: "We are what we repeatedly do. Excellence, then, is not an act but ",
    mark: "a habit",
    after: ".",
    author: "Will Durant",
    marker: 2,
  },
  {
    before: "The expert in anything was once ",
    mark: "a beginner",
    after: ".",
    author: "Helen Hayes",
    marker: 4,
  },
  {
    before: "Little by little, ",
    mark: "one travels far",
    after: ".",
    author: "J. R. R. Tolkien",
    marker: 2,
  },
  {
    before: "You don't have to be great to start, but you have to ",
    mark: "start to be great",
    after: ".",
    author: "Zig Ziglar",
    marker: 3,
  },
  {
    before: "Perfection is not attainable. But if we chase perfection we can catch ",
    mark: "excellence",
    after: ".",
    author: "Vince Lombardi",
    marker: 1,
  },
];

/** Days since the epoch, in local time — the same day for the whole day. */
export function localEpochDay(date = new Date()): number {
  return Math.floor(
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() / 86_400_000,
  );
}

/**
 * The quote for a given day. Deterministic, so the workbench does not reshuffle
 * itself every time the view re-renders.
 */
export function quoteOfTheDay(date = new Date()): Quote {
  const day = localEpochDay(date);
  const index = ((day % QUOTES.length) + QUOTES.length) % QUOTES.length;
  return QUOTES[index];
}
