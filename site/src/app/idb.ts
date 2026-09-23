/**
 * Minimal IndexedDB wrapper. One database, a handful of object stores:
 * - `kv`          profile / plan / mistakes[] / vocab[] / feedback[] / misc flags
 * - `sessions`    Session JSON by id
 * - `exams`       imported Exam JSON by id (bundled exams live in /content)
 * - `blobs`       user-supplied binary assets (audio, images) by relative path
 * - `transcripts` imported Transcript JSON by examId
 *
 * Everything is local-first: no sync, no telemetry. The shape deliberately
 * mirrors the desktop data layout so export/import can move between them.
 */

const DB_NAME = "ielts-workspace";
const DB_VERSION = 1;

export type StoreName = "kv" | "sessions" | "exams" | "blobs" | "transcripts";

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of ["kv", "sessions", "exams", "blobs", "transcripts"] as const) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB 打开失败"));
    });
  }
  return dbPromise;
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB 请求失败"));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB 事务失败"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB 事务中止"));
  });
}

export async function idbGet<T>(store: StoreName, key: string): Promise<T | undefined> {
  const db = await openDb();
  const tx = db.transaction(store, "readonly");
  const value = await reqToPromise(tx.objectStore(store).get(key));
  return value as T | undefined;
}

export async function idbSet(store: StoreName, key: string, value: unknown): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).put(value, key);
  await txDone(tx);
}

export async function idbDel(store: StoreName, key: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).delete(key);
  await txDone(tx);
}

export async function idbKeys(store: StoreName): Promise<string[]> {
  const db = await openDb();
  const tx = db.transaction(store, "readonly");
  const keys = await reqToPromise(tx.objectStore(store).getAllKeys());
  return keys.filter((k): k is string => typeof k === "string");
}

export async function idbAll<T>(store: StoreName): Promise<T[]> {
  const db = await openDb();
  const tx = db.transaction(store, "readonly");
  const values = await reqToPromise(tx.objectStore(store).getAll());
  return values as T[];
}

/** Rough byte accounting for the settings page's storage meter. */
export async function idbUsageEstimate(): Promise<{ usage?: number; quota?: number }> {
  if (!navigator.storage?.estimate) return {};
  const { usage, quota } = await navigator.storage.estimate();
  return { usage, quota };
}
