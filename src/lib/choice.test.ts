import { describe, expect, it } from "vitest";
import { selectedLetters, toggleSharedLetter } from "./choice";

const questions = [
  { id: "q12", number: 12 },
  { id: "q11", number: 11 },
];

function toggle(
  values: Record<string, string | string[] | null | undefined>,
  letter: string,
  limit = 2,
) {
  return toggleSharedLetter({ questions, values, letter, limit });
}

describe("selectedLetters", () => {
  it("follows the given question order and skips empty slots", () => {
    expect(selectedLetters(questions, { q11: "A", q12: "C" })).toEqual(["C", "A"]);
    expect(selectedLetters([{ id: "q11" }, { id: "q12" }], { q11: "A", q12: "C" })).toEqual(["A", "C"]);
    expect(selectedLetters([{ id: "q11" }, { id: "q12" }], { q11: null, q12: "C" })).toEqual(["C"]);
  });
});

describe("toggleSharedLetter", () => {
  it("writes the first two clicks onto questions sorted by number", () => {
    const afterA = toggle({}, "A");
    expect(afterA).toEqual({ q11: "A", q12: null });
    expect(toggle(afterA, "C")).toEqual({ q11: "A", q12: "C" });
    expect(selectedLetters([{ id: "q11" }, { id: "q12" }], toggle(afterA, "C"))).toEqual(["A", "C"]);
  });

  it("keeps click order, not letter order", () => {
    const afterC = toggle({}, "C");
    expect(afterC).toEqual({ q11: "C", q12: null });
    expect(toggle(afterC, "A")).toEqual({ q11: "C", q12: "A" });
  });

  it("unchecking compact remaining letters into earlier questions", () => {
    const two = { q11: "A", q12: "C" };
    expect(toggle(two, "A")).toEqual({ q11: "C", q12: null });
    expect(toggle(two, "C")).toEqual({ q11: "A", q12: null });
  });

  it("ignores a new letter when the group is already full", () => {
    const full = { q11: "A", q12: "C" };
    expect(toggle(full, "B")).toEqual({ q11: "A", q12: "C" });
  });

  it("appends when still under the limit", () => {
    const three = [
      { id: "q11", number: 11 },
      { id: "q12", number: 12 },
      { id: "q13", number: 13 },
    ];
    expect(
      toggleSharedLetter({
        questions: three,
        values: { q11: "A", q12: "C" },
        letter: "B",
        limit: 3,
      }),
    ).toEqual({ q11: "A", q12: "C", q13: "B" });
  });
});
