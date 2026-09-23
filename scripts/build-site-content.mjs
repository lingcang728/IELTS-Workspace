#!/usr/bin/env node
/**
 * Build the web content bundle for site/public/content/.
 *
 * Sources (already public in this repo / shipped with the desktop app):
 *   fixtures/cambridge/*.json          -> content/exams/<exam.id>.json
 *   fixtures/transcripts/*.json        -> content/transcripts/<examId>.json
 *   fixtures/assets/cambridge/*.jpg    -> content/assets/cambridge/*.jpg
 *   fixtures/assets/cambridge/*.mp3    -> content/assets/cambridge/*.mp3
 *   data-dev/official-samples/*.json   -> content/exams/<exam.id>.json (if present)
 *   site/content-meta.json             -> curated frequency/difficulty tags
 *
 * Listening MP3s are bundled when fixtures/assets/cambridge/*.mp3 exists
 * locally. In CI the pages workflow restores them from the listening-audio-v1
 * GitHub release zips first; a fresh clone without audio just marks those
 * exams audioStatus "missing" (honest) and the web runtime falls back to the
 * release URL. IndexedDB user blobs still take priority at runtime.
 *
 * Output index.json carries ExamSummary rows plus book/test/questionTypes so
 * the library page can filter without opening every exam file.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "site/public/content");
const metaPath = join(root, "site/content-meta.json");

const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : { exams: {} };

mkdirSync(join(out, "exams"), { recursive: true });
mkdirSync(join(out, "transcripts"), { recursive: true });
mkdirSync(join(out, "assets/cambridge"), { recursive: true });

const BOOK_RE = /^cambridge-(\d+)-test-(\d+)-/;

/** @param {any} exam */
function summarize(exam, relPath) {
  const m = exam.id.match(BOOK_RE);
  const transcripts = new Set(
    readdirSync(join(out, "transcripts")).map((f) => f.replace(/\.json$/, "")),
  );
  return {
    id: exam.id,
    title: exam.title,
    module: exam.module,
    source: exam.source,
    path: relPath,
    durationMs: exam.policy?.endCondition?.durationMs,
    questionCount: (exam.sections ?? []).reduce(
      (n, s) => n + (s.questionGroups ?? []).reduce((k, g) => k + (g.questions ?? []).length, 0),
      0,
    ),
    hasTranscript: transcripts.has(exam.id),
    audioStatus:
      exam.module !== "listening"
        ? "ready"
        : audioReady(exam)
          ? "ready"
          : "missing",
    audioAssets:
      exam.module === "listening"
        ? [
            ...new Set(
              (exam.sections ?? []).map((s) => s.audioAsset).filter(Boolean),
            ),
          ]
        : undefined,
    book: m ? Number(m[1]) : undefined,
    test: m ? Number(m[2]) : undefined,
    partLabels: (exam.sections ?? []).map((s) => s.title),
    questionTypes: [
      ...new Set(
        (exam.sections ?? []).flatMap((s) =>
          (s.questionGroups ?? []).map((g) => g.questionType).filter(Boolean),
        ),
      ),
    ],
    meta: meta.exams?.[exam.id],
  };
}

/** Listening audio is ready when the MP3 was actually copied into content/. */
function audioReady(exam) {
  return (exam.sections ?? [])
    .map((s) => s.audioAsset)
    .filter(Boolean)
    .every((rel) => existsSync(join(out, String(rel).replace(/^\/+/, ""))));
}

const exams = [];
const seen = new Set();

function ingestDir(dir, relFrom) {
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".json")) continue;
    let exam;
    try {
      exam = JSON.parse(readFileSync(join(dir, file), "utf8"));
    } catch {
      console.warn(`跳过损坏文件 ${file}`);
      continue;
    }
    if (exam.schemaVersion !== 1 || !exam.id || exam.source?.kind === "generated_practice") continue;
    if (seen.has(exam.id)) continue;
    seen.add(exam.id);
    writeFileSync(join(out, "exams", `${exam.id}.json`), JSON.stringify(exam));
    exams.push(summarize(exam, `content/exams/${exam.id}.json`));
  }
}

// Transcripts first so hasTranscript resolves during summarize.
const transcriptDir = join(root, "fixtures/transcripts");
if (existsSync(transcriptDir)) {
  for (const file of readdirSync(transcriptDir)) {
    if (!file.endsWith(".json")) continue;
    cpSync(join(transcriptDir, file), join(out, "transcripts", file));
  }
}

const assetDir = join(root, "fixtures/assets/cambridge");
if (existsSync(assetDir)) {
  for (const file of readdirSync(assetDir)) {
    if (/\.(jpg|mp3)$/i.test(file)) cpSync(join(assetDir, file), join(out, "assets/cambridge", file));
  }
}

ingestDir(join(root, "fixtures/cambridge"));
ingestDir(join(root, "fixtures/official-samples"));
// Local-only extras (gitignored): picked up on a dev machine, absent in CI.
ingestDir(join(root, "data-dev/official-samples"));

exams.sort((a, b) => {
  const key = (e) => `${e.module}:${String(e.book ?? 99).padStart(2, "0")}:${String(e.test ?? 99).padStart(2, "0")}:${e.id}`;
  return key(a).localeCompare(key(b));
});

writeFileSync(
  join(out, "index.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), exams }, null, 0),
);
console.log(`content: ${exams.length} exams -> ${out}`);
