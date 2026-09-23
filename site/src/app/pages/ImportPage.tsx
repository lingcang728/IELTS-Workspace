import { useCallback, useEffect, useRef, useState } from "react";
import type { Route } from "../nav";
import { importExam, importTranscript, listExams, loadExam, saveBlob } from "../api";
import { idbDel, idbGet, idbKeys } from "../idb";
import type { IndexedExam } from "../content";
import type { Transcript } from "../types";
import {
  AUDIO_PACKS,
  exportBackup,
  formatBytes,
  importAudioFiles,
  importAudioZip,
  importBackup,
  sniffJson,
  type AudioImportResult,
  type JsonSniff,
} from "../lib/importer";

type Msg = { ok: boolean; text: string } | null;

interface BlobRow {
  path: string;
  size: number;
}

function MsgLine({ msg }: { msg: Msg }) {
  if (!msg) return null;
  return (
    <p className={msg.ok ? "meta" : "import-error"} role="status">
      {msg.text}
    </p>
  );
}

export default function ImportPage({ route }: { route: Route }) {
  /* ---------------------------------------------------- ① 试卷 / 转录 JSON */
  const [jsonText, setJsonText] = useState("");
  const [sniff, setSniff] = useState<JsonSniff | null>(null);
  const [jsonBusy, setJsonBusy] = useState(false);
  const [jsonMsg, setJsonMsg] = useState<Msg>(null);
  const [jsonOver, setJsonOver] = useState(false);
  const jsonInputRef = useRef<HTMLInputElement>(null);

  function acceptJsonText(text: string) {
    setJsonText(text);
    setJsonMsg(null);
    setSniff(text.trim() ? sniffJson(text) : null);
  }

  function readJsonFile(file: File) {
    void file.text().then(acceptJsonText);
  }

  async function confirmJsonImport() {
    if (!sniff || sniff.kind === "unknown") return;
    setJsonBusy(true);
    setJsonMsg(null);
    try {
      if (sniff.kind === "transcript") {
        const t = sniff.value as Transcript;
        await importTranscript(t.examId, t);
        setJsonMsg({ ok: true, text: `已入库：${t.examId} 的听力转录` });
      } else {
        const { id } = await importExam(jsonText);
        const title = sniff.label.replace(/^试卷 · /, "");
        setJsonMsg({ ok: true, text: `已入库：${title}（${id}）` });
      }
      setJsonText("");
      setSniff(null);
      void refreshListening();
    } catch (err) {
      setJsonMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setJsonBusy(false);
    }
  }

  /* ------------------------------------------------------- ② 听力音频导入 */
  const [listeningExams, setListeningExams] = useState<IndexedExam[]>([]);
  const [examId, setExamId] = useState(() => route.query.get("exam") ?? "");
  const [expectedPaths, setExpectedPaths] = useState<string[]>([]);
  const [singleMsg, setSingleMsg] = useState<Msg>(null);
  const singleInputRef = useRef<HTMLInputElement>(null);
  const pendingPathRef = useRef<string | null>(null);

  const refreshListening = useCallback(async () => {
    const exams = (await listExams()).filter((e) => e.module === "listening");
    exams.sort((a, b) => (a.book ?? 0) - (b.book ?? 0) || (a.test ?? 0) - (b.test ?? 0));
    setListeningExams(exams);
  }, []);

  useEffect(() => {
    void refreshListening();
  }, [refreshListening]);

  // 选中试卷后读出它期望的音频相对路径（去重；通常只有一条整轨路径）。
  useEffect(() => {
    let alive = true;
    setExpectedPaths([]);
    setSingleMsg(null);
    if (!examId) return;
    void loadExam(examId)
      .then((exam) => {
        if (!alive) return;
        const paths = [...new Set(exam.sections.map((s) => s.audioAsset).filter(Boolean) as string[])];
        setExpectedPaths(paths);
        if (paths.length === 0) setSingleMsg({ ok: false, text: "该试卷 JSON 里没有 audioAsset 字段" });
      })
      .catch(() => alive && setSingleMsg({ ok: false, text: "试卷加载失败" }));
    return () => {
      alive = false;
    };
  }, [examId]);

  async function saveSingleAudio(file: File) {
    const path = pendingPathRef.current;
    pendingPathRef.current = null;
    if (!path) return;
    try {
      await saveBlob(path, file);
      setSingleMsg({ ok: true, text: `已入库：${path}` });
      void refreshBlobs();
    } catch (err) {
      setSingleMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    }
  }

  /* ------------------------------------------------- ②b 批量 / ZIP 导入 */
  const batchInputRef = useRef<HTMLInputElement>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);
  const [batchResult, setBatchResult] = useState<AudioImportResult | null>(null);

  function mergeResults(a: AudioImportResult, b: AudioImportResult): AudioImportResult {
    return { saved: [...a.saved, ...b.saved], unmatched: [...a.unmatched, ...b.unmatched] };
  }

  async function runBatch(files: File[]) {
    setBatchBusy(true);
    setBatchProgress(null);
    setBatchResult(null);
    try {
      let result: AudioImportResult = { saved: [], unmatched: [] };
      const loose: { name: string; blob: Blob }[] = [];
      for (const file of files) {
        if (file.name.toLowerCase().endsWith(".zip")) {
          setBatchProgress({ done: 0, total: 1 });
          const r = await importAudioZip(await file.arrayBuffer(), (done, total) =>
            setBatchProgress({ done, total }),
          );
          result = mergeResults(result, r);
        } else {
          loose.push({ name: file.name, blob: file });
        }
      }
      if (loose.length) {
        const r = await importAudioFiles(loose, (done, total) => setBatchProgress({ done, total }));
        result = mergeResults(result, r);
      }
      setBatchResult(result);
      void refreshBlobs();
    } catch (err) {
      setBatchResult({ saved: [], unmatched: [`导入失败：${err instanceof Error ? err.message : String(err)}`] });
    } finally {
      setBatchBusy(false);
      setBatchProgress(null);
    }
  }

  /* ----------------------------------------------------- ②c 下载音频包 */
  const [packId, setPackId] = useState(AUDIO_PACKS[0]?.id ?? "C04");
  const [dlBusy, setDlBusy] = useState(false);
  const [dlStatus, setDlStatus] = useState<string | null>(null);
  const [dlResult, setDlResult] = useState<AudioImportResult | null>(null);

  async function downloadPack() {
    const pack = AUDIO_PACKS.find((p) => p.id === packId);
    if (!pack || dlBusy) return;
    setDlBusy(true);
    setDlResult(null);
    setDlStatus(`正在下载 ${pack.file}…`);
    try {
      const res = await fetch(pack.href);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setDlStatus("下载完成，正在解压…");
      const r = await importAudioZip(await res.blob(), (done, total) =>
        setDlStatus(`正在解压并入库 ${done}/${total}…`),
      );
      setDlResult(r);
      setDlStatus(null);
      void refreshBlobs();
    } catch {
      setDlStatus(`下载失败（网络或跨域限制）。可点右侧链接手动下载 ${pack.file} 后用「批量导入」入库。`);
    } finally {
      setDlBusy(false);
    }
  }

  /* --------------------------------------------------- ③ 已入库音频清单 */
  const [blobRows, setBlobRows] = useState<BlobRow[] | null>(null);

  const refreshBlobs = useCallback(async () => {
    const keys = (await idbKeys("blobs")).sort();
    const rows: BlobRow[] = [];
    for (const key of keys) {
      const blob = await idbGet<Blob>("blobs", key);
      rows.push({ path: key, size: blob?.size ?? 0 });
    }
    setBlobRows(rows);
  }, []);

  useEffect(() => {
    void refreshBlobs();
  }, [refreshBlobs]);

  async function removeBlob(path: string) {
    await idbDel("blobs", path);
    void refreshBlobs();
  }

  /* ------------------------------------------------------ ④ 备份 / 恢复 */
  const [includeAudio, setIncludeAudio] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupMsg, setBackupMsg] = useState<Msg>(null);
  const restoreInputRef = useRef<HTMLInputElement>(null);

  async function doExport() {
    setBackupBusy(true);
    setBackupMsg(null);
    try {
      const backup = await exportBackup(includeAudio);
      const blob = new Blob([JSON.stringify(backup)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      a.href = url;
      a.download = `ielts-workspace-backup-${stamp}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setBackupMsg({ ok: true, text: "备份已导出为下载文件。" });
    } catch (err) {
      setBackupMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBackupBusy(false);
    }
  }

  async function doRestore(file: File) {
    setBackupBusy(true);
    setBackupMsg(null);
    try {
      const r = await importBackup(await file.text());
      setBackupMsg({
        ok: true,
        text: `恢复完成，共写入 ${r.total} 条记录（会话 ${r.counts.sessions ?? 0} · 试卷 ${r.counts.exams ?? 0} · 转录 ${r.counts.transcripts ?? 0} · 音频 ${r.counts.blobs ?? 0} · 其他 ${r.counts.kv ?? 0}）。`,
      });
      void refreshBlobs();
      void refreshListening();
    } catch (err) {
      setBackupMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBackupBusy(false);
    }
  }

  /* -------------------------------------------------------------- render */
  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <h1>导入数据</h1>
          <p>导入试卷 JSON、听力音频，或备份 / 恢复整个浏览器本地库。</p>
        </div>
      </header>

      <section className="workspace-card import-card">
        <h2>导入试卷 JSON</h2>
        <p className="meta">
          支持 Schema v1 试卷（schemaVersion + id + sections）与听力转录（schemaVersion + examId +
          sections.lines），自动识别类型。
        </p>
        <input
          ref={jsonInputRef}
          className="sr-only"
          type="file"
          accept=".json,application/json"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) readJsonFile(f);
            e.target.value = "";
          }}
        />
        <div
          className={`import-drop${jsonOver ? " over" : ""}`}
          role="button"
          tabIndex={0}
          aria-label="选择 JSON 文件导入"
          onClick={() => jsonInputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              jsonInputRef.current?.click();
            }
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setJsonOver(true);
          }}
          onDragLeave={() => setJsonOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setJsonOver(false);
            const f = e.dataTransfer.files[0];
            if (f) readJsonFile(f);
          }}
        >
          <strong>点击选择 JSON 文件，或拖到此处</strong>
          <small>也可以把 JSON 粘贴到下方文本框</small>
        </div>
        <textarea
          rows={8}
          value={jsonText}
          onChange={(e) => acceptJsonText(e.target.value)}
          placeholder="粘贴 Schema v1 试卷 JSON 或听力转录 JSON…"
        />
        {sniff && (
          <p className={sniff.kind === "unknown" ? "import-error" : "meta"}>
            {sniff.kind === "unknown" ? sniff.label : `识别为：${sniff.label}`}
          </p>
        )}
        <MsgLine msg={jsonMsg} />
        <button
          type="button"
          className="primary-button"
          disabled={jsonBusy || !sniff || sniff.kind === "unknown"}
          onClick={() => void confirmJsonImport()}
        >
          {jsonBusy ? "导入中…" : "确认导入"}
        </button>
      </section>

      <section className="workspace-card import-card">
        <h2>导入听力音频</h2>
        <p className="notice-strip">
          网页版不自带音频（与桌面一致）：把官方整轨 mp3 存进浏览器本地库，试卷里的
          audioAsset 路径对上即可播放。
        </p>

        <h3 className="meta">单个试卷</h3>
        <label className="field">
          <span>选择听力试卷</span>
          <span className="select-field">
            <select value={examId} onChange={(e) => setExamId(e.target.value)}>
              <option value="">— 请选择 —</option>
              {listeningExams.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.title}
                </option>
              ))}
            </select>
          </span>
        </label>
        {examId && expectedPaths.length > 0 && (
          <div>
            <p className="meta">该试卷期望的音频路径：</p>
            {expectedPaths.map((path) => (
              <div key={path} className="button-row" style={{ alignItems: "center" }}>
                <code className="meta" style={{ flex: 1 }}>
                  {path}
                </code>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    pendingPathRef.current = path;
                    singleInputRef.current?.click();
                  }}
                >
                  选择 mp3 入库
                </button>
              </div>
            ))}
          </div>
        )}
        <input
          ref={singleInputRef}
          className="sr-only"
          type="file"
          accept=".mp3,audio/mpeg,audio/*"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void saveSingleAudio(f);
            e.target.value = "";
          }}
        />
        <MsgLine msg={singleMsg} />

        <h3 className="meta">批量导入（多选 mp3 或 ZIP）</h3>
        <p className="meta">
          按文件名里的 cNN-tM 自动映射到 <code>assets/cambridge/cNN-tM.mp3</code>（c4-t1 与 c04-t1
          都会映射到剑 4）。识别不了的文件名会列出来，可用上方单个导入手动挂载。
        </p>
        <input
          ref={batchInputRef}
          className="sr-only"
          type="file"
          multiple
          accept=".zip,.mp3,.m4a,.wav,audio/*,application/zip"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length) void runBatch(files);
            e.target.value = "";
          }}
        />
        <div className="button-row">
          <button
            type="button"
            className="secondary-button"
            disabled={batchBusy}
            onClick={() => batchInputRef.current?.click()}
          >
            {batchBusy
              ? batchProgress
                ? `入库中 ${batchProgress.done}/${batchProgress.total}…`
                : "入库中…"
              : "选择 mp3 / ZIP 批量导入"}
          </button>
        </div>
        {batchResult && (
          <div>
            {batchResult.saved.length > 0 && (
              <p className="meta">已入库 {batchResult.saved.length} 个：{batchResult.saved.map((r) => r.path).join("、")}</p>
            )}
            {batchResult.unmatched.length > 0 && (
              <p className="import-error">未识别 {batchResult.unmatched.length} 个：{batchResult.unmatched.join("、")}</p>
            )}
          </div>
        )}

        <h3 className="meta">下载音频包（可选）</h3>
        <p className="meta">
          分册 ZIP 来自本站 GitHub Release（listening-audio-v1，C04–C20）。下载后自动解压、按文件名映射入库。
        </p>
        <div className="button-row" style={{ alignItems: "center" }}>
          <span className="select-field">
            <select value={packId} onChange={(e) => setPackId(e.target.value)} disabled={dlBusy}>
              {AUDIO_PACKS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}（{p.file}）
                </option>
              ))}
            </select>
          </span>
          <button type="button" className="secondary-button" disabled={dlBusy} onClick={() => void downloadPack()}>
            {dlBusy ? "下载中…" : "下载并入库"}
          </button>
          <a className="meta" href={AUDIO_PACKS.find((p) => p.id === packId)?.href} target="_blank" rel="noreferrer">
            手动下载
          </a>
        </div>
        {dlStatus && <p className="meta">{dlStatus}</p>}
        {dlResult && (
          <div>
            {dlResult.saved.length > 0 && (
              <p className="meta">已入库 {dlResult.saved.length} 个：{dlResult.saved.map((r) => r.path).join("、")}</p>
            )}
            {dlResult.unmatched.length > 0 && (
              <p className="import-error">跳过 {dlResult.unmatched.length} 个无法识别的文件：{dlResult.unmatched.join("、")}</p>
            )}
          </div>
        )}
      </section>

      <section className="workspace-card import-card">
        <h2>已入库音频</h2>
        {blobRows == null ? (
          <p className="meta">读取中…</p>
        ) : blobRows.length === 0 ? (
          <p className="meta">还没有导入任何音频。听力试卷会显示「音频未导入」，但不影响看题做题。</p>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 6 }}>
            {blobRows.map((row) => (
              <li key={row.path} className="button-row" style={{ alignItems: "center", marginTop: 0 }}>
                <code className="meta" style={{ flex: 1 }}>
                  {row.path}
                </code>
                <span className="meta">{formatBytes(row.size)}</span>
                <button type="button" className="link-button" onClick={() => void removeBlob(row.path)}>
                  删除
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="workspace-card import-card">
        <h2>备份 / 恢复</h2>
        <p className="meta">
          导出整个本地库（设置、会话、错题、生词、导入的试卷与转录）为单个 JSON 文件；恢复时与现有数据合并，同名键覆盖。
        </p>
        <label className="meta" style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={includeAudio} onChange={(e) => setIncludeAudio(e.target.checked)} />
          含音频（文件较大）
        </label>
        <div className="button-row">
          <button type="button" className="primary-button" disabled={backupBusy} onClick={() => void doExport()}>
            导出备份
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={backupBusy}
            onClick={() => restoreInputRef.current?.click()}
          >
            导入备份
          </button>
        </div>
        <input
          ref={restoreInputRef}
          className="sr-only"
          type="file"
          accept=".json,application/json"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void doRestore(f);
            e.target.value = "";
          }}
        />
        <MsgLine msg={backupMsg} />
      </section>
    </div>
  );
}
