import { describe, expect, it } from "vitest";
import { legendModel } from "../src/scene/legend.js";
import { makeCity } from "./fixture.js";

describe("legendModel", () => {
  const entries = legendModel(makeCity());

  it("states the view and the city's shape first", () => {
    expect(entries[0]).toEqual({
      swatch: null,
      label: "view full",
      detail: "3 districts, 4 buildings, 2 arrows",
    });
  });

  it("derives one line per binding from the artifact, unmeasured count included", () => {
    const height = entries.find((entry) => entry.label.startsWith("height"));
    expect(height?.label).toBe("height = loc (linear)");
    expect(height?.detail).toContain("1 unmeasured, drawn at the minimum");
    const footprint = entries.find((entry) => entry.label.startsWith("footprint"));
    expect(footprint?.label).toBe("footprint = members (sqrt)");
    expect(footprint?.detail).not.toContain("unmeasured");
  });

  it("explains exactly the swatches the renderer draws — no retired hues", () => {
    // Arrows only ever render in the fan direction hues now (provenance is the
    // saturation channel); a declared/inferred swatch would describe colors
    // that never appear.
    expect(entries.map((entry) => entry.swatch).filter((s) => s !== null)).toEqual([
      "building",
      "stub",
      "fanIn",
      "fanOut",
    ]);
  });

  it("declares the layout algorithm and its gaps", () => {
    const layout = entries.at(-1);
    expect(layout?.label).toBe("layout shelf-rows");
    expect(layout?.detail).toBe("gaps 2/3/6 (street/sidewalk/avenue)");
  });

  it("adds the tangle entry ONLY when the artifact marks a feedback set", () => {
    expect(entries.some((entry) => entry.swatch === "tangle")).toBe(false);
    const base = makeCity();
    const tangled = makeCity({
      arrows: base.arrows.map((arrow, i) => ({ ...arrow, feedback: i === 0 })) as never,
    });
    const withTangle = legendModel(tangled);
    const entry = withTangle.find((candidate) => candidate.swatch === "tangle");
    expect(entry?.label).toBe("tangle");
    expect(entry?.detail).toContain("minimum feedback set");
    // District-level cuts alone also earn the entry.
    const districtTangled = makeCity({
      districtArrows: base.districtArrows.map((arrow, i) => ({
        ...arrow,
        feedback: i === 0,
      })) as never,
    });
    expect(legendModel(districtTangled).some((candidate) => candidate.swatch === "tangle")).toBe(
      true,
    );
  });

  it("adds the heat and age entries ONLY for a replay artifact", () => {
    expect(entries.some((entry) => entry.swatch === "heat")).toBe(false);
    const replayCity = {
      ...makeCity(),
      replay: { clock: "revisions", ticks: [], series: {} },
    } as unknown as Parameters<typeof legendModel>[0];
    const withReplay = legendModel(replayCity);
    expect(withReplay.some((entry) => entry.swatch === "heat")).toBe(true);
    expect(withReplay.some((entry) => entry.swatch === "age")).toBe(true);
  });
});

/**
 * M10d: the role channel is LEGENDED like every other channel — a color whose
 * meaning is not stated is not a fact. The entries come from the artifact's own
 * `roles` declaration, so the key cannot list a role the classification never
 * assigned, nor omit one it did.
 */
describe("legendModel: the role channel", () => {
  function withRoles() {
    const city = makeCity() as unknown as Record<string, unknown>;
    return {
      ...city,
      roles: { framework: "spring", values: ["controller", "repository", "service"] },
    } as unknown as Parameters<typeof legendModel>[0];
  }

  it("names the framework that spoke, and calls the channel an inference", () => {
    const entries = legendModel(withRoles());
    const header = entries.find((entry) => entry.label.startsWith("roles ="));
    expect(header?.label).toBe("roles = spring (Colors -> Role)");
    expect(header?.detail).toContain("INFERENCE from written annotations");
  });

  it("gives every declared role its own swatch, with the color the renderer draws", () => {
    const entries = legendModel(withRoles());
    const roles = entries.filter((entry) => entry.swatch === "role");
    expect(roles.map((entry) => entry.label)).toEqual(["controller", "repository", "service"]);
    expect(new Set(roles.map((entry) => entry.color)).size).toBe(3);
    for (const entry of roles) expect(typeof entry.color).toBe("number");
  });

  it("says nothing about roles for an artifact that declares none", () => {
    const entries = legendModel(makeCity());
    expect(entries.some((entry) => entry.swatch === "role")).toBe(false);
    expect(entries.some((entry) => entry.label.startsWith("roles ="))).toBe(false);
  });
});
