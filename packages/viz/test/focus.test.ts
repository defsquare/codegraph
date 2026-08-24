import { describe, expect, it } from "vitest";
import { arcState, highlightMap, type ArrowToggles } from "../src/scene/focus.js";
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

describe("highlightMap", () => {
  const arcs = [
    { from: "s", to: "dep", weight: 0.5, external: false },
    { from: "user", to: "s", weight: 0.5, external: false },
    { from: "x", to: "y", weight: 0.5, external: false },
  ];

  it("marks the selection as origin and each visible arc's far end by direction", () => {
    const map = highlightMap(arcs, "s", toggles());
    expect(map.get("s")).toBe("origin");
    expect(map.get("dep")).toBe("fanOut");
    expect(map.get("user")).toBe("fanIn");
    // Non-incident endpoints are untouched.
    expect(map.has("x")).toBe(false);
    expect(map.has("y")).toBe(false);
  });

  it("is empty when nothing is selected", () => {
    expect(highlightMap(arcs, null, toggles()).size).toBe(0);
  });

  it("follows the arc decision table: a toggled-off direction highlights nothing", () => {
    const map = highlightMap(arcs, "s", toggles({ fanOut: false }));
    expect(map.has("dep")).toBe(false);
    expect(map.get("user")).toBe("fanIn");
    expect(map.get("s")).toBe("origin");
  });

  it("keeps the origin highlighted even with every direction off", () => {
    const map = highlightMap(arcs, "s", toggles({ fanIn: false, fanOut: false }));
    expect(map.get("s")).toBe("origin");
    expect(map.size).toBe(1);
  });

  it("hides the far end of a hidden external arc", () => {
    const external = [{ from: "s", to: "stub", weight: 0.5, external: true }];
    expect(highlightMap(external, "s", toggles({ externals: false })).has("stub")).toBe(false);
    expect(highlightMap(external, "s", toggles()).get("stub")).toBe("fanOut");
  });

  it("lets fan-in win on a mutual dependency", () => {
    const mutual = [
      { from: "s", to: "peer", weight: 0.5, external: false },
      { from: "peer", to: "s", weight: 0.5, external: false },
    ];
    expect(highlightMap(mutual, "s", toggles()).get("peer")).toBe("fanIn");
  });
});
