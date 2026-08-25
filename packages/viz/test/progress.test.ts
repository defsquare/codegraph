import { describe, expect, it } from "vitest";
import { progressFraction, progressLabel } from "../src/progress.js";

describe("progressLabel", () => {
  it("shows received over total, in MB", () => {
    expect(progressLabel(13_003_162, 59_400_000)).toBe("loading city — 12.4 / 56.6 MB");
  });

  it("shows received alone when the server sent no total", () => {
    expect(progressLabel(13_003_162, null)).toBe("loading city — 12.4 MB");
  });
});

describe("progressFraction", () => {
  it("is received/total, clamped to 1", () => {
    expect(progressFraction(25, 100)).toBeCloseTo(0.25);
    expect(progressFraction(150, 100)).toBe(1);
  });

  it("is null when there is no usable total — the bar cannot claim a fraction", () => {
    expect(progressFraction(25, null)).toBeNull();
    expect(progressFraction(25, 0)).toBeNull();
  });
});
