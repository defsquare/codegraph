import { describe, expect, it } from "vitest";
import { arcState, type ArrowToggles } from "../src/scene/focus.js";
import { ARROW_ALPHA_FOCUS, ARROW_ALPHA_MAX, ARROW_ALPHA_MIN } from "../src/theme.js";

/**
 * The decision table behind "edges appear when you click": one pure function
 * serves BOTH arc families (type arrows under a selected building, district
 * arrows under a selected district), so the two layers cannot drift apart.
 * Resting state is HIDDEN — the city shows no dependency it was not asked for.
 */
const arc = { from: "a", to: "b", weight: 0.5 };
const toggles = (overrides: Partial<ArrowToggles> = {}): ArrowToggles => ({
  fanIn: true,
  fanOut: true,
  showAll: false,
  ...overrides,
});

describe("arcState", () => {
  it("hides every arc when nothing is selected and the overview is off", () => {
    expect(arcState(arc, null, toggles())).toEqual({ role: "hidden", alpha: 0 });
  });

  it("rests at weight-scaled alpha when the overview toggle is on", () => {
    const state = arcState(arc, null, toggles({ showAll: true }));
    expect(state.role).toBe("resting");
    expect(state.alpha).toBeCloseTo(
      ARROW_ALPHA_MIN + arc.weight * (ARROW_ALPHA_MAX - ARROW_ALPHA_MIN),
    );
  });

  it("shows a selection's outgoing arcs as fan-out and incoming as fan-in", () => {
    const out = arcState(arc, "a", toggles());
    expect(out.role).toBe("fanOut");
    expect(out.alpha).toBeCloseTo(
      ARROW_ALPHA_MIN + arc.weight * (ARROW_ALPHA_FOCUS - ARROW_ALPHA_MIN),
    );
    expect(arcState(arc, "b", toggles()).role).toBe("fanIn");
  });

  it("hides non-incident arcs entirely while something is selected — even with the overview on", () => {
    expect(arcState(arc, "elsewhere", toggles({ showAll: true }))).toEqual({
      role: "hidden",
      alpha: 0,
    });
  });

  it("honours the per-direction toggles", () => {
    expect(arcState(arc, "a", toggles({ fanOut: false })).role).toBe("hidden");
    expect(arcState(arc, "b", toggles({ fanIn: false })).role).toBe("hidden");
  });
});
