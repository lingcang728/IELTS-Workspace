/** Group exam summaries into Cambridge books / official / imported for the catalog grid. */
import type { ExamSummary } from "./types";
import type { CatalogModule } from "./view";

const MODULE_ORDER = ["listening", "reading", "writing"] as const;

export type CatalogGroup = {
  key: string;
  label: string;
  kind: "cambridge" | "official" | "imported" | "other";
  book?: number;
  tests: CatalogTestRow[];
};

export type CatalogTestRow = {
  key: string;
  label: string;
  test?: number;
  exams: ExamSummary[];
};

export function cambridgeParts(id: string): { book: number; test: number; module: string } | null {
  const match = /^cambridge-(\d+)-test-(\d+)-([a-z]+)$/.exec(id);
  if (!match) return null;
  return { book: Number(match[1]), test: Number(match[2]), module: match[3] };
}

export function groupCatalog(exams: ExamSummary[]): CatalogGroup[] {
  const byBook = new Map<number, Map<number, ExamSummary[]>>();
  const official: ExamSummary[] = [];
  const imported: ExamSummary[] = [];
  const other: ExamSummary[] = [];

  for (const exam of exams) {
    const parts = cambridgeParts(exam.id);
    if (parts) {
      let tests = byBook.get(parts.book);
      if (!tests) {
        tests = new Map();
        byBook.set(parts.book, tests);
      }
      const row = tests.get(parts.test);
      if (row) row.push(exam);
      else tests.set(parts.test, [exam]);
      continue;
    }
    if (exam.source?.kind === "official_sample") {
      official.push(exam);
      continue;
    }
    if (exam.source?.kind === "imported_document") {
      imported.push(exam);
      continue;
    }
    other.push(exam);
  }

  const groups: CatalogGroup[] = [];
  if (official.length) {
    groups.push(flatGroup("official", "官方样题", "official", official));
  }
  for (const book of [...byBook.keys()].sort((a, b) => a - b)) {
    const testsMap = byBook.get(book)!;
    groups.push({
      key: `cambridge-${book}`,
      label: `剑 ${book}`,
      kind: "cambridge",
      book,
      tests: [...testsMap.keys()].sort((a, b) => a - b).map((test) => ({
        key: `cambridge-${book}-test-${test}`,
        label: `Test ${test}`,
        test,
        exams: sortExams(testsMap.get(test)!),
      })),
    });
  }
  if (other.length) groups.push(flatGroup("other", "其他", "other", other));
  if (imported.length) groups.push(flatGroup("imported", "本地导入", "imported", imported));
  return groups;
}

export function filterCatalog(groups: CatalogGroup[], module: CatalogModule, query: string): CatalogGroup[] {
  const needle = query.trim().toLowerCase();
  const compact = needle.replace(/\s+/g, "");
  const out: CatalogGroup[] = [];
  for (const group of groups) {
    const tests = group.tests
      .map((test) => ({
        ...test,
        exams: module === "all" ? test.exams : test.exams.filter((exam) => exam.module === module),
      }))
      .filter((test) => test.exams.length > 0 && matchesQuery(group, test, needle, compact));
    if (tests.length) out.push({ ...group, tests });
  }
  return out;
}

function flatGroup(
  key: string,
  label: string,
  kind: Exclude<CatalogGroup["kind"], "cambridge">,
  exams: ExamSummary[],
): CatalogGroup {
  return { key, label, kind, tests: [{ key, label, exams: sortExams(exams) }] };
}

function sortExams(exams: ExamSummary[]): ExamSummary[] {
  return [...exams].sort((a, b) => {
    const rank = moduleRank(a.module) - moduleRank(b.module);
    return rank !== 0 ? rank : a.id.localeCompare(b.id);
  });
}

function moduleRank(module: string) {
  const index = (MODULE_ORDER as readonly string[]).indexOf(module);
  return index === -1 ? 99 : index;
}

function matchesQuery(group: CatalogGroup, test: CatalogTestRow, needle: string, compact: string) {
  if (!needle) return true;
  const haystacks = [group.label, test.label];
  if (group.book != null) haystacks.push(`剑 ${group.book}`, `剑${group.book}`);
  if (test.test != null) haystacks.push(`Test ${test.test}`, `test ${test.test}`);
  for (const exam of test.exams) haystacks.push(exam.title, exam.id);
  return haystacks.some((text) => {
    const lower = text.toLowerCase();
    return lower.includes(needle) || lower.replace(/\s+/g, "").includes(compact);
  });
}
