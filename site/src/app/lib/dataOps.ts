/** 数据维护小工具（不依赖 jszip，供 SettingsPage / StorageMeter 使用）。 */
import { idbDel, idbKeys, type StoreName } from "../idb";
import { invalidateContentIndex } from "../content";

const ALL_STORES: readonly StoreName[] = ["kv", "sessions", "exams", "transcripts", "blobs"];

export async function clearAllData(): Promise<void> {
  for (const store of ALL_STORES) {
    for (const key of await idbKeys(store)) {
      await idbDel(store, key);
    }
  }
  invalidateContentIndex();
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
