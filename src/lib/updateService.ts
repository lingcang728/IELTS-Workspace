export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "installing"
  | "failed"
  | "upToDate";

export interface UpdateViewState {
  status: UpdateStatus;
  currentVersion: string;
  version: string;
  date: string;
  notes: string;
  sizeBytes: number | null;
  downloadedBytes: number;
  totalBytes: number | null;
  error: string;
}

const AUTO_CHECK_KEY = "ielts-workspace-updater-last-auto-check-v1";
const AUTO_CHECK_INTERVAL = 24 * 60 * 60 * 1_000;

let state: UpdateViewState = {
  status: "idle",
  currentVersion: "",
  version: "",
  date: "",
  notes: "",
  sizeBytes: null,
  downloadedBytes: 0,
  totalBytes: null,
  error: "",
};

type Listener = () => void;
type TauriUpdate = Awaited<ReturnType<typeof import("@tauri-apps/plugin-updater")["check"]>>;

const listeners = new Set<Listener>();
let pendingUpdate: TauriUpdate = null;

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function publish(patch: Partial<UpdateViewState>): void {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function packageSize(raw: Record<string, unknown>): number | null {
  const direct = positiveNumber(raw.size);
  if (direct !== null) return direct;
  const platforms = raw.platforms;
  if (!platforms || typeof platforms !== "object") return null;
  for (const value of Object.values(platforms)) {
    if (value && typeof value === "object") {
      const size = positiveNumber((value as Record<string, unknown>).size);
      if (size !== null) return size;
    }
  }
  return null;
}

async function loadCurrentVersion(): Promise<void> {
  if (state.currentVersion || !isTauriRuntime()) return;
  const { getVersion } = await import("@tauri-apps/api/app");
  publish({ currentVersion: await getVersion() });
}

export function subscribeToUpdates(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getUpdateState(): UpdateViewState {
  return state;
}

export async function checkForDesktopUpdate(manual = false): Promise<void> {
  if (!isTauriRuntime()) return;
  publish({ status: "checking", error: "" });
  try {
    await loadCurrentVersion();
    const lastCheck = Number(localStorage.getItem(AUTO_CHECK_KEY) ?? 0);
    if (!manual && Date.now() - lastCheck < AUTO_CHECK_INTERVAL) {
      publish({ status: "upToDate" });
      return;
    }

    const { check } = await import("@tauri-apps/plugin-updater");
    pendingUpdate = await check({ timeout: 15_000 });
    if (!pendingUpdate) {
      localStorage.setItem(AUTO_CHECK_KEY, String(Date.now()));
      publish({ status: "upToDate", version: "", notes: "", sizeBytes: null });
      return;
    }

    localStorage.removeItem(AUTO_CHECK_KEY);
    const sizeBytes = packageSize(pendingUpdate.rawJson);
    publish({
      status: "available",
      currentVersion: pendingUpdate.currentVersion,
      version: pendingUpdate.version,
      date: pendingUpdate.date ?? "",
      notes: pendingUpdate.body ?? "",
      sizeBytes,
      downloadedBytes: 0,
      totalBytes: sizeBytes,
    });
  } catch (error) {
    pendingUpdate = null;
    publish({ status: "failed", error: errorMessage(error) });
  }
}

export async function downloadAndInstallDesktopUpdate(): Promise<void> {
  if (!pendingUpdate || state.status !== "available") {
    publish({ status: "failed", error: "没有可安装的更新，请重新检查。" });
    return;
  }

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const portable = await invoke<boolean>("is_portable_update");
    publish({ status: "downloading", error: "", downloadedBytes: 0 });
    await pendingUpdate.downloadAndInstall((event) => {
      if (event.event === "Started") {
        publish({ totalBytes: event.data.contentLength ?? state.sizeBytes });
      } else if (event.event === "Progress") {
        publish({ downloadedBytes: state.downloadedBytes + event.data.chunkLength });
      } else {
        publish({ status: "installing" });
      }
    });
    publish({ status: "installing" });
    if (portable) {
      await invoke("launch_migrated_install");
    } else {
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    }
  } catch (error) {
    publish({ status: "failed", error: errorMessage(error) });
  }
}

export function resetUpdateServiceForTests(): void {
  pendingUpdate = null;
  state = {
    status: "idle",
    currentVersion: "",
    version: "",
    date: "",
    notes: "",
    sizeBytes: null,
    downloadedBytes: 0,
    totalBytes: null,
    error: "",
  };
  localStorage.removeItem(AUTO_CHECK_KEY);
  listeners.forEach((listener) => listener());
}
