import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { AudioLibraryStatus } from "./types";

export type MatchKind = "catalogHash" | "knownHash" | "filenameDuration" | "manual" | "confirmed" | "folderLayout";
export type BindingMode = "fullTrack" | "parts";

export interface ScannedPart {
  path: string;
  fileName: string;
  sha256: string;
  durationMs: number;
  format: string;
  bytes: number;
  modifiedMs: number;
}

export interface ExamImportRow {
  examId: string;
  book: number;
  test: number;
  parts: Array<ScannedPart | null>;
  /** Official whole-track file whose SHA-256 matched the built-in catalog;
   *  `parts` stays empty for these rows. */
  wholeTrack?: ScannedPart | null;
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

export async function audioPickFiles(): Promise<string[]> {
  return invoke("audio_pick_files");
}

export async function audioPickFolders(): Promise<string[]> {
  return invoke("audio_pick_folders");
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
