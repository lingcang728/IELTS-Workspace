import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { AudioLibraryStatus } from "./types";

export type MatchKind = "catalogHash" | "knownHash" | "filenameDuration" | "manual" | "confirmed";
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

export interface AudioImportCandidate {
  path: string;
  fileName: string;
  sha256: string;
  durationMs: number;
  examId?: string | null;
  partIndex?: number | null;
  confidence: string;
  matchKind?: MatchKind | null;
  needsConfirm: boolean;
  reason: string;
}

export interface AudioImportPlan {
  candidates: AudioImportCandidate[];
  ready: AudioImportCandidate[];
  needsConfirm: AudioImportCandidate[];
  unknown: AudioImportCandidate[];
  errors: string[];
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

export interface Waveform {
  durationMs: number;
  peaks: number[];
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

export async function audioScanPaths(paths: string[]): Promise<AudioImportPlan> {
  return invoke("audio_scan_paths", { paths });
}

export async function audioConfirmImport(candidates: AudioImportCandidate[]): Promise<unknown> {
  return invoke("audio_confirm_import", { candidatesJson: JSON.stringify(candidates) });
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

export async function audioSetManualParts(examId: string, startsMs: number[], path: string): Promise<unknown> {
  return invoke("audio_set_manual_parts", { examId, startsMs, path });
}

export async function audioWaveform(path: string): Promise<Waveform> {
  return invoke("audio_waveform", { path });
}

export async function audioOpenGuide(): Promise<string> {
  return invoke("audio_open_guide");
}

export function localMediaSrc(absPath: string) {
  return convertFileSrc(absPath);
}
