import { describe, expect, it } from "vitest";
import { makeHighlight, recoverHighlight } from "./highlight";
import { codePointLength, codePointToUtf16, sha256HexUtf8, sliceCodePoints, toNfc, utf16ToCodePoint } from "./unicode";

describe("unicode offsets", () => {
  it("ASCII", () => {
    const s = toNfc("hello world");
    expect(utf16ToCodePoint(s, 6)).toBe(6);
    expect(codePointLength(s)).toBe(11);
  });

  it("Chinese counts as one code point each", () => {
    const s = toNfc("汉字abc");
    expect(codePointLength(s)).toBe(5);
    expect(utf16ToCodePoint(s, 2)).toBe(2);
  });

  it("accented NFC", () => {
    const s = toNfc("café");
    expect(codePointLength(s)).toBe(4);
  });

  it("composed vs decomposed NFC", async () => {
    const a = "café"; // composed
    const b = "cafe\u0301"; // decomposed
    expect(toNfc(a)).toBe(toNfc(b));
    expect(await sha256HexUtf8(toNfc(a))).toBe(await sha256HexUtf8(toNfc(b)));
  });

  it("newlines are code points", () => {
    const s = toNfc("ab\ncd");
    expect(codePointLength(s)).toBe(5);
  });

  it("counts a surrogate pair as one code point", () => {
    const s = toNfc("a😀b");
    expect(codePointLength(s)).toBe(3);
    expect(utf16ToCodePoint(s, s.length)).toBe(3);
    expect(codePointToUtf16(s, 1)).toBe(1);
    expect(codePointToUtf16(s, 2)).toBe(3);
    expect(sliceCodePoints(s, 1, 2)).toBe("😀");
  });
});

describe("highlight hash and recovery", () => {
  it("hash match restores by offset", async () => {
    const source = "The library opened in 1842 near the river.";
    const hl = await makeHighlight({
      targetId: "p1",
      sourceText: source,
      startUtf16: 4,
      endUtf16: 11,
    });
    expect(hl.excerpt).toBe("library");
    expect(hl.offsetUnit).toBe("unicode_code_point");
    const rec = await recoverHighlight(hl, source);
    expect(rec.invalid).toBe(false);
    expect(rec.startOffset).toBe(hl.startOffset);
  });

  it("hash mismatch uses unique excerpt context", async () => {
    const source = "Alpha library closed. Beta library opened.";
    const hl = await makeHighlight({
      targetId: "p1",
      sourceText: source,
      startUtf16: source.indexOf("Beta library"),
      endUtf16: source.indexOf("Beta library") + "Beta library".length,
    });
    const mutated = "Alpha hall closed. Beta library opened.";
    const rec = await recoverHighlight(hl, mutated);
    expect(rec.invalid).not.toBe(true);
    expect(rec.recovered).toBe(true);
  });

  it("content change without unique match is marked invalid, never silent", async () => {
    const source = "one two three";
    const hl = await makeHighlight({
      targetId: "p1",
      sourceText: source,
      startUtf16: 4,
      endUtf16: 7,
    });
    const rec = await recoverHighlight(hl, "completely different text");
    expect(rec.invalid).toBe(true);
  });

  it("Chinese highlight offsets", async () => {
    const source = "故宫博物院收藏了大量文物。";
    const hl = await makeHighlight({
      targetId: "p1",
      sourceText: source,
      startUtf16: 0,
      endUtf16: 5,
    });
    expect(hl.excerpt).toBe("故宫博物院");
    expect(hl.endOffset - hl.startOffset).toBe(5);
  });
});
