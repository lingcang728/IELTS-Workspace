import { describe, expect, it } from "vitest";
import { bandLabel, bandTable, rawNeededForBand, rawToBand } from "./band";

describe("rawToBand", () => {
  it("matches the published listening boundaries", () => {
    expect(rawToBand("listening", 40)).toBe(9);
    expect(rawToBand("listening", 39)).toBe(9);
    expect(rawToBand("listening", 35)).toBe(8);
    expect(rawToBand("listening", 32)).toBe(7.5);
    expect(rawToBand("listening", 30)).toBe(7);
    expect(rawToBand("listening", 31)).toBe(7);
    expect(rawToBand("listening", 29)).toBe(6.5);
    expect(rawToBand("listening", 23)).toBe(6);
    expect(rawToBand("listening", 18)).toBe(5.5);
    expect(rawToBand("listening", 10)).toBe(4);
  });

  it("matches the published academic reading boundaries", () => {
    expect(rawToBand("reading", 40)).toBe(9);
    expect(rawToBand("reading", 30)).toBe(7);
    expect(rawToBand("reading", 29)).toBe(6.5);
    expect(rawToBand("reading", 23)).toBe(6);
    expect(rawToBand("reading", 20)).toBe(5.5);
    expect(rawToBand("reading", 15)).toBe(5);
    expect(rawToBand("reading", 4)).toBe(2.5);
  });

  it("never uses the old raw/total*9 formula", () => {
    // 23/40*9 = 5.175, which under-reports listening band 6.0 by nearly a band.
    expect(rawToBand("listening", 23)).not.toBeCloseTo((23 / 40) * 9, 1);
    expect(rawToBand("reading", 20)).not.toBeCloseTo((20 / 40) * 9, 1);
  });

  it("returns null below the table and for modules without a table", () => {
    expect(rawToBand("reading", 3)).toBeNull();
    expect(rawToBand("listening", 9)).toBeNull();
    expect(rawToBand("writing", 30)).toBeNull();
    expect(rawToBand("speaking", 30)).toBeNull();
    expect(rawToBand("listening", Number.NaN)).toBeNull();
  });

  it("labels bands with one decimal and an em dash when unknown", () => {
    expect(bandLabel("listening", 30)).toBe("7.0");
    expect(bandLabel("reading", 3)).toBe("—");
  });
});

describe("bandTable", () => {
  it("is ordered high to low and covers every raw score down to the floor", () => {
    for (const module of ["listening", "reading"] as const) {
      const rows = bandTable(module);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0].max).toBe(40);
      for (let i = 0; i < rows.length; i += 1) {
        expect(rows[i].min).toBeLessThanOrEqual(rows[i].max);
        if (i > 0) expect(rows[i].max).toBe(rows[i - 1].min - 1);
      }
    }
  });
});

describe("rawNeededForBand", () => {
  it("reports the smallest raw score reaching a target band", () => {
    expect(rawNeededForBand("listening", 7)).toBe(30);
    expect(rawNeededForBand("listening", 6.5)).toBe(26);
    expect(rawNeededForBand("reading", 7)).toBe(30);
    expect(rawNeededForBand("reading", 6)).toBe(23);
  });

  it("returns null for unreachable targets and untabled modules", () => {
    expect(rawNeededForBand("listening", 9.5)).toBeNull();
    expect(rawNeededForBand("writing", 7)).toBeNull();
  });
});
