import { describe, expect, it } from "vitest";
import { arcState, type ArrowToggles } from "../src/scene/focus.js";
import { ARROW_ALPHA_FOCUS, ARROW_ALPHA_MIN } from "../src/theme.js";

/**
 * The decision table behind "edges appear when you click": one pure function
 * serves BOTH arc families (type arrows under a selected building, district
 * arrows under a selected district), so the two layers cannot drift apart.
 * Arcs are HIDDEN unless something is selected — and an external arc (an
 * endpoint the model only stubbed) shows only while externals are shown.
 */
const arc = { from: "a", to: "b", weight: 0.5, external: false };
const toggles = (overrides: Partial<ArrowToggles> = {}): ArrowToggles => ({
  fanIn: true,
  fanOut: true,
  externals: true,
  ...overrides,
});

describe("arcState", () => {
  it("hides every arc when nothing is selected", () => {
    expect(arcState(arc, null, toggles())).toEqual({ role: "hidden", alpha: 0 });
  });

  it("shows a selection's outgoing arcs as fan-out and incoming as fan-in", () => {
    const out = arcState(arc, "a", toggles());
    expect(out.role).toBe("fanOut");
    expect(out.alpha).toBeCloseTo(
      ARROW_ALPHA_MIN + arc.weight * (ARROW_ALPHA_FOCUS - ARROW_ALPHA_MIN),
    );
    expect(arcState(arc, "b", toggles()).role).toBe("fanIn");
  });

  it("hides non-incident arcs entirely while something is selected", () => {
    expect(arcState(arc, "elsewhere", toggles())).toEqual({ role: "hidden", alpha: 0 });
  });

  it("honours the per-direction toggles", () => {
    expect(arcState(arc, "a", toggles({ fanOut: false })).role).toBe("hidden");
    expect(arcState(arc, "b", toggles({ fanIn: false })).role).toBe("hidden");
  });

  it("hides an external arc when externals are hidden, even under selection", () => {
    const external = { ...arc, external: true };
    expect(arcState(external, "a", toggles({ externals: false }))).toEqual({
      role: "hidden",
      alpha: 0,
    });
    expect(arcState(external, "a", toggles()).role).toBe("fanOut");
    // An internal arc is untouched by the externals toggle.
    expect(arcState(arc, "a", toggles({ externals: false })).role).toBe("fanOut");
  });
});
