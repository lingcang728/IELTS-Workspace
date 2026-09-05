/** NFC only. Offset unit is Unicode code point, never UTF-16 code unit. */

export function toNfc(text: string): string {
  return text.normalize("NFC");
}

function utf16Step(text: string, index: number): number {
  const code = text.charCodeAt(index);
  return code >= 0xd800 && code <= 0xdbff && index + 1 < text.length ? 2 : 1;
}

export function codePointLength(text: string): number {
  const nfc = toNfc(text);
  let i = 0;
  let count = 0;
  while (i < nfc.length) {
    i += utf16Step(nfc, i);
    count++;
  }
  return count;
}

export function utf16ToCodePoint(nfcText: string, utf16Index: number): number {
  const clamped = Math.max(0, Math.min(utf16Index, nfcText.length));
  let i = 0;
  let count = 0;
  while (i < clamped) {
    i += utf16Step(nfcText, i);
    count++;
  }
  return count;
}

export function codePointToUtf16(nfcText: string, codePointOffset: number): number {
  let i = 0;
  let count = 0;
  while (i < nfcText.length && count < codePointOffset) {
    i += utf16Step(nfcText, i);
    count++;
  }
  return i;
}

export function sliceCodePoints(nfcText: string, start: number, end: number): string {
  const a = codePointToUtf16(nfcText, start);
  const b = codePointToUtf16(nfcText, end);
  return nfcText.slice(a, b);
}

export async function sha256HexUtf8(nfcText: string): Promise<string> {
  const bytes = new TextEncoder().encode(nfcText);
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
