import type { HighlightRecord } from "./types";
import {
  codePointLength,
  codePointToUtf16,
  sha256HexUtf8,
  sliceCodePoints,
  toNfc,
  utf16ToCodePoint,
} from "./unicode";

const CONTEXT = 24;

export async function makeHighlight(opts: {
  targetId: string;
  sourceText: string;
  startUtf16: number;
  endUtf16: number;
}): Promise<HighlightRecord> {
  const nfc = toNfc(opts.sourceText);
  const start = utf16ToCodePoint(nfc, opts.startUtf16);
  const end = utf16ToCodePoint(nfc, opts.endUtf16);
  const a = Math.max(0, Math.min(start, end));
  const b = Math.min(codePointLength(nfc), Math.max(start, end));
  const excerpt = sliceCodePoints(nfc, a, b);
  const contextBefore = sliceCodePoints(nfc, Math.max(0, a - CONTEXT), a);
  const contextAfter = sliceCodePoints(nfc, b, Math.min(codePointLength(nfc), b + CONTEXT));
  const textHash = await sha256HexUtf8(nfc);
  return {
    id: `hl-${Date.now()}-${a}-${b}`,
    targetId: opts.targetId,
    startOffset: a,
    endOffset: b,
    offsetUnit: "unicode_code_point",
    textHash,
    contextBefore,
    contextAfter,
    excerpt,
  };
}

export type RecoveredHighlight = HighlightRecord & { recovered?: boolean };

export async function recoverHighlight(
  hl: HighlightRecord,
  currentText: string,
): Promise<RecoveredHighlight> {
  const nfc = toNfc(currentText);
  const hash = await sha256HexUtf8(nfc);
  if (hash === hl.textHash) {
    const len = codePointLength(nfc);
    if (hl.startOffset >= 0 && hl.endOffset <= len && hl.startOffset < hl.endOffset) {
      return { ...hl, invalid: false, recovered: false };
    }
  }
  const needle = `${hl.contextBefore}${hl.excerpt}${hl.contextAfter}`;
  if (hl.excerpt && nfc.includes(hl.excerpt)) {
    if (needle && nfc.includes(needle)) {
      const needleCount = nfc.split(needle).length - 1;
      if (needleCount === 1) {
        const idx = nfc.indexOf(needle);
        const startUtf = idx + hl.contextBefore.length;
        const start = utf16ToCodePoint(nfc, startUtf);
        const end = start + codePointLength(hl.excerpt);
        return {
          ...hl,
          startOffset: start,
          endOffset: end,
          textHash: hash,
          invalid: false,
          recovered: true,
        };
      }
    }
    const count = nfc.split(hl.excerpt).length - 1;
    if (count === 1) {
      const idx = nfc.indexOf(hl.excerpt);
      const start = utf16ToCodePoint(nfc, idx);
      return {
        ...hl,
        startOffset: start,
        endOffset: start + codePointLength(hl.excerpt),
        textHash: hash,
        invalid: false,
        recovered: true,
      };
    }
  }
  return { ...hl, invalid: true };
}

export function applyMarks(nfcText: string, highlights: HighlightRecord[]): string {
  const chars = [...nfcText];
  const valid = highlights
    .filter((h) => !h.invalid && h.startOffset < h.endOffset && h.endOffset <= chars.length)
    .sort((a, b) => a.startOffset - b.startOffset);
  if (!valid.length) return escapeHtml(nfcText);

  let html = "";
  let cursor = 0;
  for (const h of valid) {
    if (h.startOffset < cursor) continue;
    html += escapeHtml(chars.slice(cursor, h.startOffset).join(""));
    const cls = h.invalid ? "hl-invalid" : "hl-mark";
    html += `<mark class="${cls}" data-hl="${escapeAttr(h.id)}">${escapeHtml(
      chars.slice(h.startOffset, h.endOffset).join(""),
    )}</mark>`;
    cursor = h.endOffset;
  }
  html += escapeHtml(chars.slice(cursor).join(""));
  return html;
}

export function rangeToUtf16(root: HTMLElement): { start: number; end: number } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(root);
  pre.setEnd(range.startContainer, range.startOffset);
  const start = pre.toString().length;
  const end = start + range.toString().length;
  if (end <= start) return null;
  return { start, end };
}

export function offsetsToUtf16(nfcText: string, start: number, end: number) {
  return {
    start: codePointToUtf16(nfcText, start),
    end: codePointToUtf16(nfcText, end),
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;");
}
