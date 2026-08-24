import { describe, expect, it } from "vitest";
import { localEpochDay, quoteOfTheDay, QUOTES } from "./quotes";

describe("QUOTES", () => {
  it("marks a phrase that really is inside the quote", () => {
    for (const quote of QUOTES) {
      expect(quote.mark.trim().length, quote.author).toBeGreaterThan(2);
      expect(quote.before.length + quote.after.length, quote.author).toBeGreaterThan(5);
    }
  });

  it("only uses marker slots that exist as tokens", () => {
    for (const quote of QUOTES) {
      expect([1, 2, 3, 4]).toContain(quote.marker);
    }
  });

  it("keeps the quote the user asked to keep", () => {
    const collier = QUOTES.find((q) => q.author === "Robert Collier");
    expect(`${collier?.before}${collier?.mark}${collier?.after}`)
      .toBe("Success is the sum of small efforts, repeated day in and day out.");
  });
});

describe("quoteOfTheDay", () => {
  it("is stable within a day", () => {
    const morning = new Date(2026, 7, 24, 8, 0, 0);
    const evening = new Date(2026, 7, 24, 23, 30, 0);
    expect(quoteOfTheDay(morning)).toBe(quoteOfTheDay(evening));
  });

  it("changes from one day to the next", () => {
    const today = new Date(2026, 7, 24);
    const tomorrow = new Date(2026, 7, 25);
    expect(quoteOfTheDay(today)).not.toBe(quoteOfTheDay(tomorrow));
  });

  it("cycles through every quote over a week of days", () => {
    const seen = new Set<string>();
    for (let offset = 0; offset < QUOTES.length; offset += 1) {
      seen.add(quoteOfTheDay(new Date(2026, 7, 24 + offset)).author);
    }
    expect(seen.size).toBe(QUOTES.length);
  });

  it("handles dates before the epoch without a negative index", () => {
    expect(() => quoteOfTheDay(new Date(1969, 0, 1))).not.toThrow();
    expect(quoteOfTheDay(new Date(1969, 0, 1))).toBeDefined();
  });
});

describe("localEpochDay", () => {
  it("does not drift across a local midnight", () => {
    expect(localEpochDay(new Date(2026, 7, 24, 0, 0, 1)))
      .toBe(localEpochDay(new Date(2026, 7, 24, 23, 59, 59)));
    expect(localEpochDay(new Date(2026, 7, 25)))
      .toBe(localEpochDay(new Date(2026, 7, 24)) + 1);
  });
});
