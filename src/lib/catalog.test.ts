import { describe, expect, it } from "vitest";
import { cambridgeParts, filterCatalog, groupCatalog } from "./catalog";
import type { ExamSummary } from "./types";

function exam(id: string, patch: Partial<ExamSummary> = {}): ExamSummary {
  const parts = cambridgeParts(id);
  const module = (patch.module ?? parts?.module ?? "reading") as ExamSummary["module"];
  return {
    id,
    title: id,
    module,
    source: { kind: "cambridge_book" },
    path: "",
    questionCount: 40,
    ...patch,
  };
}

describe("cambridgeParts", () => {
  it("parses book, test, and module from a Cambridge id", () => {
    expect(cambridgeParts("cambridge-18-test-2-listening")).toEqual({
      book: 18,
      test: 2,
      module: "listening",
    });
  });

  it("rejects ids that are not cambridge-{book}-test-{test}-{module}", () => {
    expect(cambridgeParts("official-sample-reading")).toBeNull();
    expect(cambridgeParts("cambridge-18-test-2")).toBeNull();
    expect(cambridgeParts("cambridge-18-test-2-listening-extra")).toBeNull();
  });
});

describe("groupCatalog", () => {
  it("orders Cambridge books numerically so 4 precedes 10", () => {
    const groups = groupCatalog([
      exam("cambridge-10-test-1-reading"),
      exam("cambridge-4-test-1-reading"),
    ]);
    expect(groups.map((group) => group.book)).toEqual([4, 10]);
    expect(groups.map((group) => group.label)).toEqual(["剑 4", "剑 10"]);
  });

  it("places official samples before Cambridge books", () => {
    const groups = groupCatalog([
      exam("cambridge-4-test-1-reading"),
      exam("official-reading", { source: { kind: "official_sample" }, title: "Official Reading" }),
    ]);
    expect(groups.map((group) => group.kind)).toEqual(["official", "cambridge"]);
    expect(groups[0].label).toBe("官方样题");
  });

  it("places imported papers last and other ids in their own group", () => {
    const groups = groupCatalog([
      exam("local-reading", { source: { kind: "imported_document" } }),
      exam("cambridge-4-test-1-reading"),
      exam("misc-reading", { source: { kind: "generated_practice" } }),
    ]);
    expect(groups.map((group) => group.kind)).toEqual(["cambridge", "other", "imported"]);
    expect(groups[2].label).toBe("本地导入");
  });

  it("sorts modules listening / reading / writing within a test", () => {
    const groups = groupCatalog([
      exam("cambridge-5-test-1-writing"),
      exam("cambridge-5-test-1-reading"),
      exam("cambridge-5-test-1-listening"),
    ]);
    expect(groups[0].tests[0].exams.map((item) => item.module)).toEqual([
      "listening",
      "reading",
      "writing",
    ]);
  });

  it("only emits tests that have papers", () => {
    const groups = groupCatalog([exam("cambridge-6-test-3-reading")]);
    expect(groups[0].tests.map((test) => test.test)).toEqual([3]);
  });
});

describe("filterCatalog", () => {
  const groups = groupCatalog([
    exam("cambridge-18-test-1-reading"),
    exam("cambridge-18-test-1-listening"),
    exam("cambridge-18-test-2-reading"),
    exam("cambridge-10-test-1-listening"),
    exam("cambridge-4-test-1-writing"),
  ]);

  it("keeps only tests that include the requested module", () => {
    const filtered = filterCatalog(groups, "listening", "");
    expect(filtered.map((group) => group.book)).toEqual([10, 18]);
    expect(filtered.flatMap((group) => group.tests.map((test) => test.key))).toEqual([
      "cambridge-10-test-1",
      "cambridge-18-test-1",
    ]);
    expect(filtered.every((group) => group.tests.every((test) => test.exams.every((item) => item.module === "listening")))).toBe(true);
  });

  it("matches 剑 N regardless of spaces or case", () => {
    const filtered = filterCatalog(groups, "all", "剑 18");
    expect(filtered.map((group) => group.book)).toEqual([18]);
    expect(filtered[0].tests).toHaveLength(2);
    expect(filterCatalog(groups, "all", "剑18").map((group) => group.book)).toEqual([18]);
  });

  it("drops groups that have no remaining tests", () => {
    expect(filterCatalog(groups, "writing", "剑 18")).toEqual([]);
  });
});
