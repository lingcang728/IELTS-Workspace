import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Icon } from "./Ui";
import {
  audioCancelImport,
  audioConfirmImport,
  audioPickFiles,
  audioPickFolder,
  audioScanPaths,
  type AudioImportPlan,
  type ExamImportRow,
  type ImportProgress,
} from "../lib/audio";

export function AudioWizard({
  targetExamId,
  onClose,
  onDone,
}: {
  targetExamId?: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<AudioImportPlan | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [accepted, setAccepted] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<ImportProgress>("audio-import-progress", (event) => {
      setProgress(event.payload);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  async function scan(paths: string[]) {
    if (!paths.length) return;
    setBusy(true);
    setError(null);
    setProgress({ phase: "scan", current: 0, total: 0, message: "正在扫描…" });
    try {
      const next = await audioScanPaths(paths, targetExamId);
      setPlan(next);
      const flags: Record<string, boolean> = {};
      for (const row of next.exams) flags[row.examId] = row.status === "ready";
      setAccepted(flags);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function pickFiles() {
    const files = await audioPickFiles().catch((e) => {
      setError(String(e));
      return [];
    });
    await scan(files);
  }

  async function pickFolder() {
    const folder = await audioPickFolder().catch((e) => {
      setError(String(e));
      return null;
    });
    if (folder) await scan([folder]);
  }

  async function confirm() {
    if (!plan) return;
    const chosen = plan.exams.filter((row) => row.status === "ready" && accepted[row.examId]).map((row) => row.examId);
    if (!chosen.length) {
      setError("没有可导入的完整试卷。每套需要 Part/Section 1–4 四个文件。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await audioConfirmImport(chosen);
      onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function cancel() {
    await audioCancelImport().catch(() => undefined);
    setBusy(false);
  }

  return (
    <div className="audio-wizard-backdrop" role="dialog" aria-modal="true" aria-labelledby="audio-wizard-title">
      <div className="audio-wizard">
        <header>
          <h2 id="audio-wizard-title">添加听力音频</h2>
          <button type="button" className="ghost-icon" onClick={onClose} aria-label="关闭"><Icon name="close" /></button>
        </header>
        <p className="meta">
          {targetExamId ? `正在为 ${targetExamId} 添加。` : "可一次导入多套。"}
          只接受剑4–20 每套恰好四个 Part/Section。不支持整轨，也不再提供时间点校准。
        </p>
        <div className="button-row">
          <button type="button" className="primary-button" disabled={busy} onClick={() => void pickFiles()}>选择文件</button>
          <button type="button" className="secondary-button" disabled={busy} onClick={() => void pickFolder()}>选择文件夹</button>
          {busy && <button type="button" className="secondary-button" onClick={() => void cancel()}>取消</button>}
        </div>
        {progress && (
          <p className="meta" role="status">
            {progress.phase === "scan" ? "扫描" : "导入"} {progress.current}/{progress.total || "…"} · {progress.message}
          </p>
        )}
        {error && <p className="form-error">{error}</p>}
        {plan && (
          <div className="audio-plan">
            {plan.skipped.map((bucket) => (
              <p key={bucket.code} className="meta">
                {bucket.reason}（{bucket.count} 个
                {bucket.examples.length ? `，例如 ${bucket.examples.join("、")}` : ""}）
              </p>
            ))}
            {plan.exams.length === 0 && <p className="meta">没有识别到完整的四段听力。</p>}
            {plan.exams.map((row) => (
              <ExamRow
                key={row.examId}
                row={row}
                checked={Boolean(accepted[row.examId])}
                onToggle={(v) => setAccepted((prev) => ({ ...prev, [row.examId]: v }))}
              />
            ))}
            <div className="button-row">
              <button type="button" className="primary-button" disabled={busy} onClick={() => void confirm()}>确认导入</button>
              <button type="button" className="secondary-button" onClick={onClose}>关闭</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ExamRow({
  row,
  checked,
  onToggle,
}: {
  row: ExamImportRow;
  checked: boolean;
  onToggle: (v: boolean) => void;
}) {
  const ready = row.status === "ready";
  const parts = [1, 2, 3, 4].map((n) => (row.parts[n - 1] ? `P${n}` : `缺${n}`)).join(" ");
  return (
    <label className="audio-candidate">
      <input type="checkbox" checked={checked && ready} disabled={!ready} onChange={(e) => onToggle(e.target.checked)} />
      <div>
        <strong>{row.examId}</strong>
        <small>{row.reason} · {parts}</small>
      </div>
    </label>
  );
}
