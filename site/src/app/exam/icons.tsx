/**
 * Exam-runtime icons — the SVG subset of `src/components/Ui.tsx` that the
 * ported exam runtime actually uses. Kept local so the exam domain never
 * imports the desktop shell's Tauri-bound component file.
 */
import type { ReactNode } from "react";

export type IconName =
  | "pen" | "clock" | "info" | "check" | "pause" | "play" | "rotate" | "lock"
  | "chevron" | "bookmark" | "volume" | "contrast" | "wordcount";

const paths: Record<IconName, ReactNode> = {
  pen: <><path d="M4 20l4.4-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Z"/><path d="m13.8 7.7 2.9 2.9M4 20h5"/></>,
  clock: <><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/></>,
  info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.2v.1"/></>,
  check: <path d="m4.5 12.5 4.5 4.5L19.5 6.5"/>,
  pause: <><path d="M9 7v10M15 7v10"/></>,
  play: <path d="m9 6 9 6-9 6V6Z"/>,
  rotate: <><path d="M20 8V4l-2 2a8.5 8.5 0 1 0 2.3 8"/><path d="M16 4h4v4"/></>,
  lock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
  chevron: <path d="m9 6 6 6-6 6"/>,
  bookmark: <path d="M6 4h12v17l-6-4-6 4V4Z"/>,
  volume: <><path d="M4 10h4l5-4v12l-5-4H4v-4Z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/></>,
  contrast: <><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 0 0 17Z" fill="currentColor" stroke="none"/></>,
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
