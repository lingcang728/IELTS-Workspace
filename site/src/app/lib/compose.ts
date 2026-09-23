/**
 * 「组一套题」— 自组模考卷。
 *
 * 听力从 P1–P4 各选一个 part、阅读从 P1–P3 各选一 passage，拼成一张新卷。
 * 产出是全新的 schemaVersion-1 Exam：题号全卷重排为 1..N，question/group/
 * section id 加槽位前缀——session 与错题本都按 questionId 记账，前后缀能
 * 保证自组卷与原卷、两张自组卷之间永不撞号。
 *
 * 听力音频：网页播放模型是「一条整轨 + 各 part 时间偏移」
 * （playbackSourceFor 只取第一个 audioAsset）。四个 part 若恰好来自同一条
 * 原卷音轨就沿用原偏移；来自不同试卷时，把各源卷的 mp3 按 part 切片
 * 解码、混单声道后拼成一条 16-bit WAV 存进 blobs（assets/custom/<id>.wav），
 * sections 的 audioAsset 全部指向它。源音频按播放同款解析链获取
 * （IndexedDB → /content 打包 → release 远端），取不到就不拼——试卷照常
 * 生成，audioStatus 如实显示「未导入」，绝不会拿别的卷的音频顶替。
 */
import { loadExam, remoteAudioSrc, saveBlob } from "../content";
import type { IndexedExam } from "../content";
import { idbGet } from "../idb";
import { cambridgeParts } from "./catalog";
import type { Exam, ExamSection } from "../types";

export type ComposeModule = "listening" | "reading";

export interface ComposeSlot {
  /** Section index inside the source exam. */
  index: number;
  label: string;
}

export function composeSlots(module: ComposeModule): ComposeSlot[] {
  const count = module === "listening" ? 4 : 3;
  return Array.from({ length: count }, (_, i) => ({ index: i, label: `P${i + 1}` }));
}

export function slotTitle(module: ComposeModule): string {
  return module === "listening" ? "自组卷 · 听力 P1–P4" : "自组卷 · 阅读 P1–P3";
}

/** 「剑18 · T2」式短标签；非剑桥卷回退到官方样题/原标题。 */
export function shortExamLabel(exam: {
  id: string;
  title: string;
  source?: { kind?: string; title?: string };
  book?: number;
  test?: number;
}): string {
  const book = exam.book ?? cambridgeParts(exam.id)?.book;
  const test = exam.test ?? cambridgeParts(exam.id)?.test;
  if (book != null && test != null) return `剑${book} · T${test}`;
  if (exam.source?.kind === "official_sample") return `官方样题 · ${exam.title}`;
  return exam.title;
}

export type SlotStatus = "none" | "open" | "done";

export interface SlotOption {
  examId: string;
  label: string;
  book?: number;
  test?: number;
  status: SlotStatus;
  /** 该卷听力音频是否已导入 blobs（阅读恒为 true）。 */
  audioReady: boolean;
}

/**
 * 某一槽位的可选试卷：同模块且确实有第 slotIndex 个 section
 * （partLabels 数量由索引构建时从 sections 读出，短缺的卷不进候选）。
 */
export function slotOptions(
  module: ComposeModule,
  slotIndex: number,
  exams: IndexedExam[],
  statusOf: (examId: string) => SlotStatus,
): SlotOption[] {
  const out: SlotOption[] = [];
  for (const exam of exams) {
    if (exam.module !== module) continue;
    if ((exam.partLabels?.length ?? 0) <= slotIndex) continue;
    out.push({
      examId: exam.id,
      label: shortExamLabel(exam),
      book: exam.book,
      test: exam.test,
      status: statusOf(exam.id),
      audioReady: module === "listening" ? exam.audioStatus === "ready" : true,
    });
  }
  return out.sort(
    (a, b) =>
      (b.book ?? -1) - (a.book ?? -1) ||
      (a.test ?? 0) - (b.test ?? 0) ||
      a.label.localeCompare(b.label, "zh-Hans-CN"),
  );
}

/** 随机选取：优先未练卷，其次未被其它槽位占用的卷，最后才是全体。 */
export function randomSlotPick(options: SlotOption[], taken: ReadonlySet<string>): string | null {
  const fresh = options.filter((o) => o.status === "none" && !taken.has(o.examId));
  const rest = options.filter((o) => !taken.has(o.examId));
  const pool = fresh.length ? fresh : rest.length ? rest : options;
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)].examId;
}

export interface ComposePick {
  examId: string;
  sectionIndex: number;
}

export interface ComposedExam {
  exam: Exam;
  totalQuestions: number;
  /** 听力：已把各 part 音频拼成一条 WAV 存入 blobs。 */
  audioMerged: boolean;
  /** 听力：所选 part 本就来同一条音轨，无需拼接，沿用原偏移。 */
  sharedAudio: boolean;
}

export async function composeExam(
  module: ComposeModule,
  picks: ComposePick[],
): Promise<ComposedExam> {
  if (!picks.length) throw new Error("没有选取任何部分");
  const sources = await Promise.all(picks.map((p) => loadExam(p.examId)));
  const id = `custom-${Date.now()}`;
  const sections: ExamSection[] = [];
  const origins: string[] = [];
  let counter = 1;

  picks.forEach((pick, slot) => {
    const source = sources[slot];
    const original = source.sections[pick.sectionIndex];
    if (!original) {
      throw new Error(`${source.title} 没有第 ${pick.sectionIndex + 1} 部分`);
    }
    const section = structuredClone(original);
    const rename = new Map<string, string>();
    section.id = `sec${slot}`;
    for (const group of section.questionGroups) {
      group.id = `s${slot}-${group.id}`;
      for (const q of group.questions) {
        const next = `s${slot}-q${counter}`;
        rename.set(q.id, next);
        q.id = next;
        q.number = counter;
        counter += 1;
      }
      // Table/flow layouts embed {{q:question-id}} placeholders; rename them
      // to the prefixed ids or the slot markers would dangle.
      if (group.layoutHtml) {
        group.layoutHtml = group.layoutHtml.replace(
          /\{\{\s*q:([^}]+)\}\}/g,
          (match, qid: string) => {
            const next = rename.get(qid.trim());
            return next ? `{{q:${next}}}` : match;
          },
        );
      }
    }
    // Section tabs carry their origin so the paper is honest about what it is.
    section.title = `P${slot + 1} · ${shortExamLabel(source)}`;
    origins.push(`P${slot + 1} ${shortExamLabel(source)}`);
    sections.push(section);
  });

  let audioMerged = false;
  let sharedAudio = false;
  if (module === "listening") {
    const assets = new Set(sections.map((s) => s.audioAsset).filter(Boolean));
    if (sections.every((s) => s.audioAsset) && assets.size === 1) {
      // All four picks ride on the same per-test track — the normal single-
      // file model already works, offsets stay as they were.
      sharedAudio = true;
    } else {
      const merged = await mergeListeningAudio(
        id,
        sections.map((s) => ({
          rel: (s.audioAsset ?? "").replace(/^\/+/, ""),
          startMs: s.audioStartMs ?? 0,
          durationMs: s.audioDurationMs ?? 0,
        })),
      );
      let at = 0;
      sections.forEach((s, i) => {
        s.audioAsset = merged?.rel ?? `assets/custom/${id}.wav`;
        s.audioStartMs = at;
        if (merged) s.audioDurationMs = merged.durationsMs[i];
        at += s.audioDurationMs ?? 0;
      });
      audioMerged = merged != null;
      // merged == null → audioAsset points at a blob that was never written,
      // so audioStatusFor reports "音频未导入" instead of playing a wrong track.
    }
  }

  // Listening keeps the source papers' media_driven policy; reading is a
  // fixed 60-minute clock with the usual 10:00 / 5:00 warnings.
  const policy = structuredClone(sources[0].policy);
  if (module === "reading") {
    policy.endCondition = { type: "fixed_duration", durationMs: 3_600_000 };
    policy.timeWarningsMs = [600_000, 300_000];
  }

  const exam: Exam = {
    schemaVersion: 1,
    id,
    title: slotTitle(module),
    module,
    source: {
      kind: "imported_document",
      title: "自组卷",
      note: `题库页组卷：${origins.join(" ｜ ")}`,
    },
    policy,
    sections,
    contentRevision: "1",
  };
  return { exam, totalQuestions: counter - 1, audioMerged, sharedAudio };
}

/* ------------------------------------------------------------- WAV merge */

interface AudioJob {
  rel: string;
  startMs: number;
  durationMs: number;
}

/** Fetch source audio bytes for slicing: imported blob → bundled /content
 * asset → GitHub release fallback (same order as playbackSourceFor). */
async function sourceAudioBytes(rel: string): Promise<ArrayBuffer | null> {
  const blob = await idbGet<Blob>("blobs", rel);
  if (blob && blob.size) return blob.arrayBuffer();
  try {
    const r = await fetch(`/content/${rel}`);
    if (r.ok) return await r.arrayBuffer();
  } catch {
    // fall through to the release fallback
  }
  const remote = remoteAudioSrc(rel);
  if (!remote) return null;
  try {
    const r = await fetch(remote);
    return r.ok ? await r.arrayBuffer() : null;
  } catch {
    return null;
  }
}

/**
 * Slice each picked part out of its source whole-test MP3 and concatenate the
 * slices into one mono 16-bit WAV under `assets/custom/<examId>.wav`.
 * Returns null when any source is unreachable or fails to decode — the
 * caller then ships the paper without audio rather than a wrong track.
 */
async function mergeListeningAudio(
  examId: string,
  jobs: AudioJob[],
): Promise<{ rel: string; durationsMs: number[] } | null> {
  try {
    if (jobs.some((j) => !j.rel)) return null;
    // 源音频字节走与播放一致的解析链：IndexedDB 导入 → /content 打包 →
    // release 远端兜底。音频内置后源卷 mp3 并不进 IndexedDB，只查 blobs
    // 会让所有跨卷组卷都拼不出音频。
    const bufs = await Promise.all(jobs.map((j) => sourceAudioBytes(j.rel)));
    if (bufs.some((b) => !b || b.byteLength === 0)) return null;
    // OfflineAudioContext resamples decoded audio to its own rate; 22050 Hz
    // mono keeps a ~32-minute track around 85 MB instead of stereo 44.1 kHz.
    const ctx = new OfflineAudioContext(2, 1, 22050);
    const chunks: Float32Array[] = [];
    const durationsMs: number[] = [];
    let rate = 0;
    for (let i = 0; i < jobs.length; i++) {
      const decoded = await ctx.decodeAudioData(bufs[i]!);
      if (rate === 0) rate = decoded.sampleRate;
      if (decoded.sampleRate !== rate || decoded.length === 0) return null;
      const from = Math.max(0, Math.floor((jobs[i].startMs / 1000) * rate));
      const to =
        jobs[i].durationMs > 0
          ? Math.min(decoded.length, Math.ceil(((jobs[i].startMs + jobs[i].durationMs) / 1000) * rate))
          : decoded.length;
      const len = Math.max(0, to - from);
      const mono = new Float32Array(len);
      const channels = Math.max(1, decoded.numberOfChannels);
      for (let c = 0; c < decoded.numberOfChannels; c++) {
        const data = decoded.getChannelData(c);
        for (let k = 0; k < len; k++) mono[k] += data[from + k];
      }
      const inv = 1 / channels;
      for (let k = 0; k < len; k++) mono[k] *= inv;
      chunks.push(mono);
      durationsMs.push(Math.round((len / rate) * 1000));
    }
    const rel = `assets/custom/${examId}.wav`;
    await saveBlob(rel, encodeWav(chunks, rate));
    return { rel, durationsMs };
  } catch {
    return null;
  }
}

/** Minimal PCM16 mono RIFF encoder — no dependencies, trivially seekable. */
function encodeWav(chunks: Float32Array[], sampleRate: number): Blob {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const buffer = new ArrayBuffer(44 + total * 2);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + total * 2, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, total * 2, true);
  let offset = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      const v = Math.max(-1, Math.min(1, chunk[i]));
      view.setInt16(offset, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: "audio/wav" });
}
