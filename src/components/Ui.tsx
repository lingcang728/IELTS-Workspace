import type { ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type IconName =
  | "grid" | "pen" | "clock" | "chart" | "book" | "headphones" | "writing"
  | "folder" | "shield" | "database" | "info" | "arrow" | "history" | "settings"
  | "search" | "target" | "check" | "pause" | "play" | "eye" | "rotate" | "lock"
  | "chevron" | "expand" | "minus" | "close" | "bookmark" | "volume" | "help"
  | "contrast" | "document" | "wordcount";

const paths: Record<IconName, ReactNode> = {
  grid: <><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/></>,
  pen: <><path d="M4 20l4.4-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Z"/><path d="m13.8 7.7 2.9 2.9M4 20h5"/></>,
  clock: <><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/></>,
  chart: <><path d="M4 20V10h4v10M10 20V4h4v16M16 20v-7h4v7"/></>,
  book: <><path d="M4 5.5c3.4-.7 5.9.1 8 2.3v11c-2.1-2.2-4.6-3-8-2.3v-11Z"/><path d="M20 5.5c-3.4-.7-5.9.1-8 2.3v11c2.1-2.2 4.6-3 8-2.3v-11Z"/></>,
  headphones: <><path d="M4 14v-2a8 8 0 0 1 16 0v2"/><path d="M4 14a2 2 0 0 1 2-2h2v7H6a2 2 0 0 1-2-2v-3ZM20 14a2 2 0 0 0-2-2h-2v7h2a2 2 0 0 0 2-2v-3Z"/></>,
  writing: <><path d="m5 19 2.4-6.4L16 4l4 4-8.6 8.6L5 19Z"/><path d="m14.5 5.5 4 4M5 19l4-1.5-2.5-2.5L5 19ZM4 21h16"/></>,
  folder: <path d="M3.5 7.5h6l2-2h9v13h-17v-11Z"/>,
  shield: <><path d="M12 3.5 20 7v5.7c0 4.2-3.1 6.7-8 8.3-4.9-1.6-8-4.1-8-8.3V7l8-3.5Z"/><path d="m8.5 12 2.2 2.2 4.8-5"/></>,
  database: <><ellipse cx="12" cy="5.5" rx="7.5" ry="3"/><path d="M4.5 5.5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6M4.5 11.5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6"/></>,
  info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.2v.1"/></>,
  arrow: <><path d="M5 12h14M14 7l5 5-5 5"/></>,
  history: <><path d="M4.5 8V4.5H8"/><path d="M5.2 6.2A8.5 8.5 0 1 1 4 14"/><path d="M12 7.5V12l3 2"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M19 13.5v-3l-2-.7a7 7 0 0 0-.8-1.8l.9-1.9-2.2-2.2-1.9.9a7 7 0 0 0-1.8-.8L10.5 2h-3l-.7 2a7 7 0 0 0-1.8.8l-1.9-.9L.9 6.1 1.8 8a7 7 0 0 0-.8 1.8l-2 .7v3l2 .7a7 7 0 0 0 .8 1.8l-.9 1.9 2.2 2.2 1.9-.9a7 7 0 0 0 1.8.8l.7 2h3l.7-2a7 7 0 0 0 1.8-.8l1.9.9 2.2-2.2-.9-1.9a7 7 0 0 0 .8-1.8l2-.7Z" transform="translate(2.5) scale(.8)"/></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></>,
  target: <><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4"/><path d="M12 2v4M22 12h-4M12 22v-4M2 12h4"/></>,
  check: <path d="m4.5 12.5 4.5 4.5L19.5 6.5"/>,
  pause: <><path d="M9 7v10M15 7v10"/></>,
  play: <path d="m9 6 9 6-9 6V6Z"/>,
  eye: <><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6S2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.5"/></>,
  rotate: <><path d="M20 8V4l-2 2a8.5 8.5 0 1 0 2.3 8"/><path d="M16 4h4v4"/></>,
  lock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
  chevron: <path d="m9 6 6 6-6 6"/>,
  expand: <><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/><path d="m3 8 5-5M21 8l-5-5M3 16l5 5M21 16l-5 5"/></>,
  minus: <path d="M5 12h14"/>,
  close: <><path d="m7 7 10 10M17 7 7 17"/></>,
  bookmark: <path d="M6 4h12v17l-6-4-6 4V4Z"/>,
  volume: <><path d="M4 10h4l5-4v12l-5-4H4v-4Z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/></>,
  help: <><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.7 2.7 0 1 1 4 2.4c-1 .6-1.5 1.1-1.5 2.1M12 17v.1"/></>,
  contrast: <><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 0 0 17Z" fill="currentColor" stroke="none"/></>,
  document: <><path d="M6 3.5h8l4 4V21H6Z"/><path d="M14 3.5V8h4M9 12h6M9 15.5h6"/></>,
  wordcount: <><circle cx="12" cy="12" r="8.5"/><path d="m9.5 9.5 5 5M14.5 9.5l-5 5"/></>,
};

export function Icon({ name, size = 20, className = "" }: { name: IconName; size?: number; className?: string }) {
  return <svg className={`ui-icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export function BrandMark({ size = 28, className = "" }: { size?: number; className?: string }) {
  return <svg className={`brand-image ${className}`} width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true">
    <path className="brand-face brand-face-left" d="M7 14.5 27.5 6 31 8.1v14.6l-5.6 2.8-10.2-4.3v23.3L27.8 52v7.1L7 46.7V14.5Z" />
    <path className="brand-face brand-face-right" d="m57 14.5-20.5-8.5L33 8.1v14.6l5.6 2.8 10.2-4.3v23.3L36.2 52v7.1L57 46.7V14.5Z" />
    <path className="brand-ridge" d="M15.2 21.2 32 29.6l16.8-8.4M32 29.6v29.5" />
  </svg>;
}

export function ModuleIcon({ module, size = 44, className = "" }: { module: "reading" | "listening" | "writing" | "speaking"; size?: number; className?: string }) {
  const icon = module === "reading" ? "book" : module === "listening" ? "headphones" : module === "writing" ? "writing" : "volume";
  return <span className={`module-image ${module} ${className}`} style={{ width: size, height: size }} aria-hidden="true"><Icon name={icon} size={Math.round(size * .56)} /></span>;
}

export async function runWindowAction(action: "minimize" | "maximize" | "fullscreen" | "close") {
  const win = getCurrentWindow();
  if (action === "minimize") await win.minimize();
  if (action === "maximize") await win.toggleMaximize();
  if (action === "fullscreen") await win.setFullscreen(!(await win.isFullscreen()));
  if (action === "close") await win.close();
}

export function WindowControls({ beforeClose }: { beforeClose?: () => void | Promise<void> }) {
  async function act(action: "minimize" | "maximize" | "close") {
    try {
      if (action === "close") await beforeClose?.();
      await runWindowAction(action);
    } catch (error) {
      if (!("__TAURI_INTERNALS__" in window)) return;
      console.error(`Window action ${action} failed`, error);
    }
  }
  return <div className="window-actions">
    <button type="button" aria-label="最小化" title="最小化" onClick={() => void act("minimize")}><Icon name="minus" size={16} /></button>
    <button type="button" aria-label="最大化或还原" title="最大化或还原" onClick={() => void act("maximize")}><span className="maximize-glyph" /></button>
    <button type="button" aria-label="关闭" title="关闭" onClick={() => void act("close")}><Icon name="close" size={17} /></button>
  </div>;
}
