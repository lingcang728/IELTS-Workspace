import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { AudioLibraryStatus } from "./types";

export type MatchKind = "catalogHash" | "knownHash" | "filenameDuration" | "manual" | "confirmed" | "folderLayout";
export type BindingMode = "fullTrack" | "parts";

export interface CatalogEntry {
  examId: string;
  book: number;
  test: number;
  standardName: string;
  sha256: string;
  bytes: number;
  durationMs: number;
  partStartsMs: number[];
  partDurationsMs: number[];
}

export interface AudioCatalog {
  schemaVersion: number;
  contentVersion: string;
  releaseTag: string;
  guideUrl: string;
  expected: number;
  entries: CatalogEntry[];
}

export interface ScannedPart {
  path: string;
  fileName: string;
  sha256: string;
  durationMs: number;
  format: string;
}

export interface ExamImportRow {
  examId: string;
  book: number;
  test: number;
  parts: Array<ScannedPart | null>;
  status: "ready" | "missing_parts" | "conflict" | string;
  missingParts: number[];
  reason: string;
}

export interface SkipBucket {
  code: string;
  reason: string;
  count: number;
  examples: string[];
}

export interface AudioImportPlan {
  exams: ExamImportRow[];
  skipped: SkipBucket[];
  readyCount: number;
  cancelled: boolean;
}

export interface ImportProgress {
  phase: string;
  current: number;
  total: number;
  message: string;
}

export interface PlaybackTrack {
  path: string;
  startMs: number;
  durationMs: number;
}

export interface PlaybackSource {
  examId: string;
  mode: BindingMode;
  tracks: PlaybackTrack[];
  partStartsMs: number[];
}

export function listeningReady(status?: string) {
  return status !== "missing" && status !== "needsReview";
}

export async function audioLibraryStatus(): Promise<AudioLibraryStatus> {
  return invoke("audio_library_status");
}

export async function audioCatalog(): Promise<AudioCatalog> {
  return invoke("audio_catalog");
}

export async function audioPickFiles(): Promise<string[]> {
  return invoke("audio_pick_files");
}

export async function audioPickFolder(): Promise<string | null> {
  return invoke("audio_pick_folder");
}

export async function audioScanPaths(paths: string[], targetExamId?: string | null): Promise<AudioImportPlan> {
  return invoke("audio_scan_paths", { paths, targetExamId: targetExamId ?? null });
}

export async function audioConfirmImport(examIds: string[]): Promise<unknown> {
  return invoke("audio_confirm_import", { examIds });
}

export async function audioCancelImport(): Promise<void> {
  return invoke("audio_cancel_import");
}

export async function audioPlaybackSource(examId: string): Promise<PlaybackSource> {
  return invoke("audio_playback_source", { examId });
}

export async function audioRemoveBinding(examId: string): Promise<void> {
  return invoke("audio_remove_binding", { examId });
}

export async function audioRepairBindings(): Promise<AudioLibraryStatus> {
  return invoke("audio_repair_bindings");
}

export async function audioOpenGuide(): Promise<string> {
  return invoke("audio_open_guide");
}

export function localMediaSrc(absPath: string) {
  return convertFileSrc(absPath);
}
