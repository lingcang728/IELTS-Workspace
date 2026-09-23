/**
 * 导入/备份的纯逻辑与 IndexedDB 写路径，供 ImportPage / SettingsPage 复用。
 * 桌面端对应物是 src/lib/audio.ts + Tauri 命令；网页端换成 File + IndexedDB。
 */
import * as JSZip from "jszip";
import { idbDel, idbGet, idbKeys, idbSet, type StoreName } from "../idb";
import { invalidateContentIndex, saveBlob } from "../content";
import type { Exam, Transcript } from "../types";

/* ------------------------------------------------------------ JSON 识别 */

export type JsonKind = "exam" | "transcript" | "unknown";

export interface JsonSniff {
  kind: JsonKind;
  /** 人读的识别结果，比如「试卷 · Cambridge IELTS 4 …」 */
  label: string;
  /** 解析出的对象（kind !== "unknown" 时可用） */
  value?: Exam | Transcript;
}

/**
 * 区分试卷 JSON 与听力转录 JSON：两者都有 schemaVersion + sections，
 * 转录多一个 examId 且 sections 里是 lines，试卷则是 id + questionGroups。
 */
export function sniffJson(text: string): JsonSniff {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return { kind: "unknown", label: "不是合法的 JSON" };
  }
  if (!obj || typeof obj !== "object") return { kind: "unknown", label: "不是合法的 JSON" };
  const rec = obj as Record<string, unknown>;
  const sections = rec.sections;
  if (
    typeof rec.schemaVersion === "number" &&
    typeof rec.examId === "string" &&
    Array.isArray(sections) &&
    sections.some((s) => s && typeof s === "object" && Array.isArray((s as { lines?: unknown }).lines))
  ) {
    return { kind: "transcript", label: `听力转录 · ${rec.examId}`, value: obj as Transcript };
  }
  if (rec.schemaVersion === 1 && typeof rec.id === "string" && Array.isArray(sections)) {
    const title = typeof rec.title === "string" && rec.title ? rec.title : rec.id;
    return { kind: "exam", label: `试卷 · ${title}`, value: obj as Exam };
  }
  return { kind: "unknown", label: "无法识别：既不是试卷（id + sections），也不是转录（examId + sections.lines）" };
}

/* ---------------------------------------------------------- 音频文件名映射 */

/** 内置剑桥听力覆盖的册/套范围（与 release 的 C04–C20 音频包一致）。 */
export const AUDIO_BOOK_MIN = 4;
export const AUDIO_BOOK_MAX = 20;
export const AUDIO_TEST_MAX = 4;

/**
 * 从文件名提取 cNN-tM：允许不补零（c4-t1）、补零（c04-t1）、
 * 下划线/空格/无分隔（c4_t1、c4 t1、c4t1）以及 test 写法（c10-test-2）。
 */
const AUDIO_NAME_RE = /c(\d{1,2})[-_\s]*t(?:est)?[-_\s]*(\d)/i;

export function audioRelPath(book: number, test: number): string {
  return `assets/cambridge/c${String(book).padStart(2, "0")}-t${test}.mp3`;
}

/** 文件名 → 期望的库内路径；匹配不上或超出目录范围返回 null。 */
export function audioPathForFileName(name: string): string | null {
  const base = name.split(/[\\/]/).pop() ?? name;
  const m = base.match(AUDIO_NAME_RE);
  if (!m) return null;
  const book = Number(m[1]);
  const test = Number(m[2]);
  if (book < AUDIO_BOOK_MIN || book > AUDIO_BOOK_MAX || test < 1 || test > AUDIO_TEST_MAX) return null;
  return audioRelPath(book, test);
}

export interface AudioImportRow {
  /** 用户给的原始文件名 */
  name: string;
  /** 入库路径（未识别时为空） */
  path?: string;
}

export interface AudioImportResult {
  saved: AudioImportRow[];
  unmatched: string[];
}

/** 逐个按文件名映射并写入 blobs；onProgress 在每个文件写完后回调。 */
export async function importAudioFiles(
  files: { name: string; blob: Blob }[],
  onProgress?: (done: number, total: number) => void,
): Promise<AudioImportResult> {
  const saved: AudioImportRow[] = [];
  const unmatched: string[] = [];
  for (let i = 0; i < files.length; i += 1) {
    const path = audioPathForFileName(files[i].name);
    if (path) {
      await saveBlob(path, files[i].blob);
      saved.push({ name: files[i].name, path });
    } else {
      unmatched.push(files[i].name);
    }
    onProgress?.(i + 1, files.length);
  }
  return { saved, unmatched };
}

const AUDIO_EXT_RE = /\.(mp3|m4a|wav|aac|ogg|flac)$/i;

/** 解压 ZIP，按文件名正则映射入库；匹配不上的条目列出来让用户手动处理。 */
export async function importAudioZip(
  data: Blob | ArrayBuffer,
  onProgress?: (done: number, total: number) => void,
): Promise<AudioImportResult> {
  const zip = await JSZip.loadAsync(data);
  const entries = Object.values(zip.files).filter((e) => {
    if (e.dir) return false;
    const base = e.name.split(/[\\/]/).pop() ?? "";
    if (!base || base.startsWith(".") || e.name.startsWith("__MACOSX/")) return false;
    return true;
  });
  const saved: AudioImportRow[] = [];
  const unmatched: string[] = [];
  let done = 0;
  for (const entry of entries) {
    const base = entry.name.split(/[\\/]/).pop() ?? entry.name;
    const path = audioPathForFileName(base);
    if (path && AUDIO_EXT_RE.test(base)) {
      const blob = await entry.async("blob");
      await saveBlob(path, blob);
      saved.push({ name: base, path });
    } else {
      unmatched.push(base);
    }
    done += 1;
    onProgress?.(done, entries.length);
  }
  return { saved, unmatched };
}

/** release 里的分册音频包（C04–C20），与官网落地页保持同一来源。 */
export const AUDIO_PACKS = Array.from({ length: AUDIO_BOOK_MAX - AUDIO_BOOK_MIN + 1 }, (_, i) => {
  const book = AUDIO_BOOK_MIN + i;
  const id = `C${String(book).padStart(2, "0")}`;
  return {
    id,
    book,
    name: `剑桥雅思 ${book}`,
    file: `${id}-listening.zip`,
    href: `https://github.com/lingcang728/IELTS-Workspace/releases/download/listening-audio-v1/${id}-listening.zip`,
  };
});

/* -------------------------------------------------------------- 备份/恢复 */

export interface BackupBlobEntry {
  /** base64 编码的文件内容 */
  data: string;
  type: string;
}

export interface BackupFile {
  app: "ielts-workspace-web";
  schemaVersion: 1;
  exportedAt: string;
  stores: Partial<Record<StoreName, Record<string, unknown>>> & {
    blobs?: Record<string, BackupBlobEntry>;
  };
}

const JSON_STORES = ["kv", "sessions", "exams", "transcripts"] as const satisfies readonly StoreName[];

export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let out = "";
  for (let i = 0; i < buf.length; i += 0x8000) {
    out += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  }
  return btoa(out);
}

export function base64ToBlob(b64: string, type = "application/octet-stream"): Blob {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type });
}

/** 导出整个 IndexedDB；音频体积大，默认不带。 */
export async function exportBackup(includeBlobs: boolean): Promise<BackupFile> {
  const stores: BackupFile["stores"] = {};
  for (const store of JSON_STORES) {
    const records: Record<string, unknown> = {};
    for (const key of await idbKeys(store)) {
      records[key] = await idbGet(store, key);
    }
    stores[store] = records;
  }
  if (includeBlobs) {
    const blobs: Record<string, BackupBlobEntry> = {};
    for (const key of await idbKeys("blobs")) {
      const blob = await idbGet<Blob>("blobs", key);
      if (blob) blobs[key] = { data: await blobToBase64(blob), type: blob.type || "audio/mpeg" };
    }
    stores.blobs = blobs;
  }
  return {
    app: "ielts-workspace-web",
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    stores,
  };
}

export interface RestoreResult {
  /** 每个 store 写入了多少条 */
  counts: Partial<Record<StoreName, number>>;
  total: number;
}

/** 恢复备份：与现有数据合并，同名键覆盖。 */
export async function importBackup(text: string): Promise<RestoreResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("备份文件不是合法的 JSON");
  }
  const backup = parsed as Partial<BackupFile>;
  if (!backup || typeof backup !== "object" || !backup.stores || typeof backup.stores !== "object") {
    throw new Error("备份文件缺少 stores 字段，格式不对");
  }
  const counts: Partial<Record<StoreName, number>> = {};
  let total = 0;
  for (const store of JSON_STORES) {
    const records = backup.stores[store];
    if (!records || typeof records !== "object") continue;
    let n = 0;
    for (const [key, value] of Object.entries(records)) {
      await idbSet(store, key, value);
      n += 1;
    }
    counts[store] = n;
    total += n;
  }
  if (backup.stores.blobs && typeof backup.stores.blobs === "object") {
    let n = 0;
    for (const [key, entry] of Object.entries(backup.stores.blobs)) {
      if (!entry || typeof entry.data !== "string") continue;
      await idbSet("blobs", key, base64ToBlob(entry.data, entry.type));
      n += 1;
    }
    counts.blobs = n;
    total += n;
  }
  invalidateContentIndex();
  return { counts, total };
}

/* -------------------------------------------------------------- 数据清空 */

/** 逐 store 清空全部记录——比 deleteDatabase 可靠：打开中的连接不会阻塞。 */
export async function clearAllData(): Promise<void> {
  for (const store of [...JSON_STORES, "blobs"] as const) {
    for (const key of await idbKeys(store)) {
      await idbDel(store, key);
    }
  }
  invalidateContentIndex();
}

/* ---------------------------------------------------------------- 小工具 */

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
