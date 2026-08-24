import { describe, expect, it } from "vitest";
import { accuracy, diffWords, words } from "./dictation";

const flat = (runs: ReturnType<typeof diffWords>) =>
  runs.map((run) => `${run.kind}:${run.words.join(" ")}`);

describe("words", () => {
  it("strips punctuation but keeps apostrophes inside words", () => {
    expect(words("Well, it's a farm-visit.")).toEqual(["Well", "it's", "a", "farm-visit"]);
  });

  it("collapses whitespace", () => {
    expect(words("  a \n b   c ")).toEqual(["a", "b", "c"]);
  });
});

describe("diffWords", () => {
  it("reports a perfect dictation as one run", () => {
    expect(flat(diffWords("the cat sat", "the cat sat"))).toEqual(["same:the cat sat"]);
  });

  it("ignores case and trailing punctuation", () => {
    expect(flat(diffWords("The cat sat.", "the cat sat"))).toEqual(["same:The cat sat"]);
  });

  it("marks a word the listener missed", () => {
    expect(flat(diffWords("the big cat sat", "the cat sat")))
      .toEqual(["same:the", "missing:big", "same:cat sat"]);
  });

  it("marks a word the listener invented", () => {
    expect(flat(diffWords("the cat sat", "the black cat sat")))
      .toEqual(["same:the", "extra:black", "same:cat sat"]);
  });

  it("handles a substitution as missing plus extra", () => {
    const runs = flat(diffWords("the cat sat", "the dog sat"));
    expect(runs).toContain("same:the");
    expect(runs.some((r) => r.startsWith("missing:cat"))).toBe(true);
    expect(runs.some((r) => r.startsWith("extra:dog"))).toBe(true);
  });

  it("handles an empty attempt", () => {
    expect(flat(diffWords("the cat sat", ""))).toEqual(["missing:the cat sat"]);
  });
});

describe("accuracy", () => {
  it("is 1 for a perfect dictation", () => {
    expect(accuracy("the cat sat", "the cat sat")).toBe(1);
  });

  it("is 0 for an empty attempt", () => {
    expect(accuracy("the cat sat", "")).toBe(0);
  });

  it("counts only transcript words, so padding cannot inflate it", () => {
    expect(accuracy("the cat sat", "the cat sat and more and more")).toBe(1);
    expect(accuracy("the big cat sat", "the cat sat")).toBeCloseTo(0.75, 5);
  });

  it("is 0 when the transcript is empty rather than dividing by zero", () => {
    expect(accuracy("", "anything")).toBe(0);
  });
});
