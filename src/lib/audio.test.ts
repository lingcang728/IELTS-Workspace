import { describe, expect, it } from "vitest";
import { listeningReady } from "./audio";

describe("listeningReady", () => {
  it("treats only a complete four-part binding as ready", () => {
    expect(listeningReady("ready")).toBe(true);
    expect(listeningReady("missing")).toBe(false);
    expect(listeningReady("needsReview")).toBe(false);
    expect(listeningReady(undefined)).toBe(true);
  });
});
