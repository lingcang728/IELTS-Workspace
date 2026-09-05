import { describe, expect, it } from "vitest";
import { clampPlaybackTime, timerWarningState } from "./examRuntime";

const WARNINGS = [600_000, 300_000];

describe("timerWarningState", () => {
  it("is quiet before the first warning", () => {
    expect(timerWarningState(601_000, WARNINGS)).toEqual({ warn: false, flash: false });
  });

  it("flashes only in the 15s after crossing 10:00 and 5:00", () => {
    expect(timerWarningState(599_000, WARNINGS)).toEqual({ warn: true, flash: true });
    expect(timerWarningState(585_001, WARNINGS)).toEqual({ warn: true, flash: true });
    expect(timerWarningState(585_000, WARNINGS)).toEqual({ warn: true, flash: false });
    expect(timerWarningState(299_000, WARNINGS)).toEqual({ warn: true, flash: true });
    expect(timerWarningState(284_000, WARNINGS)).toEqual({ warn: true, flash: false });
  });

  it("stays red without flashing through the rest of the last 10 minutes", () => {
    expect(timerWarningState(400_000, WARNINGS)).toEqual({ warn: true, flash: false });
    expect(timerWarningState(10_000, WARNINGS)).toEqual({ warn: true, flash: false });
  });
});

describe("clampPlaybackTime", () => {
  it("lets practice seeking move the lock", () => {
    expect(clampPlaybackTime(40, 10, true)).toEqual({ time: 40, lock: 40, snapped: false });
  });

  it("snaps mock playback back when jumping forward or backward", () => {
    expect(clampPlaybackTime(20, 10, false).snapped).toBe(true);
    expect(clampPlaybackTime(20, 10, false).time).toBe(10);
    expect(clampPlaybackTime(9.5, 10, false).snapped).toBe(true);
    expect(clampPlaybackTime(9.5, 10, false).time).toBe(10);
  });

  it("allows natural playback to advance the lock", () => {
    const next = clampPlaybackTime(10.2, 10, false);
    expect(next.snapped).toBe(false);
    expect(next.lock).toBe(10.2);
  });
});
