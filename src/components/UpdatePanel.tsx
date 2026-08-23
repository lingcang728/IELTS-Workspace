import { useState, useSyncExternalStore } from "react";
import { Icon } from "./Ui";
import {
  checkForDesktopUpdate,
  downloadAndInstallDesktopUpdate,
  getUpdateState,
  subscribeToUpdates,
} from "../lib/updateService";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value: string): string {
  if (!value) return "发布时间未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function UpdatePanel() {
  const update = useSyncExternalStore(subscribeToUpdates, getUpdateState, getUpdateState);
  const [confirming, setConfirming] = useState(false);
  const busy = ["checking", "downloading", "installing"].includes(update.status);
  const progress = update.totalBytes
    ? Math.min(100, Math.round(update.downloadedBytes / update.totalBytes * 100))
    : null;
  const status = {
    idle: "尚未检查",
    checking: "正在检查 GitHub Release",
    available: `发现新版本 ${update.version}`,
    downloading: progress === null ? "正在下载更新" : `正在下载 ${progress}%`,
    installing: "正在安装，完成后会自动重启",
    failed: "更新失败",
    upToDate: "当前已是最新版本",
  }[update.status];

  const install = async () => {
    setConfirming(false);
    await downloadAndInstallDesktopUpdate();
  };

  return <div className={`workspace-card update-card update-${update.status}`}>
    <div className="update-card-head">
      <div><Icon name="rotate" size={28} /><h2>软件更新</h2><p className="meta">每天最多静默检查一次，也可随时手动检查。</p></div>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => void checkForDesktopUpdate(true)}>
        <Icon name="rotate" size={15} />{update.status === "checking" ? "检查中…" : "检查更新"}
      </button>
    </div>
    <div className="update-state" role="status" aria-live="polite">
      <i aria-hidden="true" /><div><strong>{status}</strong>
        {update.status === "failed"
          ? <p>{update.error}</p>
          : update.status === "available"
            ? <p>当前 {update.currentVersion} · {formatDate(update.date)}{update.sizeBytes ? ` · ${formatBytes(update.sizeBytes)}` : ""}</p>
            : <p>版本 {update.currentVersion || "读取中"}</p>}
      </div>
    </div>
    {update.status === "downloading" && progress !== null && <progress value={progress} max="100">{progress}%</progress>}
    {update.status === "available" && <div className="update-release">
      <div><strong>IELTS Workspace {update.version}</strong><p>{update.notes || "本次 Release 未填写更新说明。"}</p></div>
      <button type="button" className="primary-button" onClick={() => setConfirming(true)}>下载安装</button>
    </div>}
    {confirming && <div className="update-confirm" role="alert">
      <div><strong>安装 IELTS Workspace {update.version}？</strong><p>安装完成后应用会自动重启，本地试卷与学习记录不会被删除。</p></div>
      <button type="button" className="secondary-button" onClick={() => setConfirming(false)}>取消</button>
      <button type="button" className="primary-button" onClick={() => void install()}>确认安装</button>
    </div>}
  </div>;
}
