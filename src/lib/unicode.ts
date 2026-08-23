/** NFC only. Offset unit is Unicode code point, never UTF-16 code unit. */

export function toNfc(text: string): string {
  return text.normalize("NFC");
}

export function codePointLength(text: string): number {
  return [...toNfc(text)].length;
}

export function utf16ToCodePoint(nfcText: string, utf16Index: number): number {
  const clamped = Math.max(0, Math.min(utf16Index, nfcText.length));
  return [...nfcText.slice(0, clamped)].length;
}

export function codePointToUtf16(nfcText: string, codePointOffset: number): number {
  const chars = [...nfcText];
  const n = Math.max(0, Math.min(codePointOffset, chars.length));
  return chars.slice(0, n).join("").length;
}

export function sliceCodePoints(nfcText: string, start: number, end: number): string {
  return [...nfcText].slice(start, end).join("");
}

export async function sha256HexUtf8(nfcText: string): Promise<string> {
  const bytes = new TextEncoder().encode(nfcText);
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
