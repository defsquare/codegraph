import { describe, expect, it } from "vitest";
import { roleColoring } from "../src/scene/roles.js";
import type { BuildingBox } from "../src/scene/buildings.js";

/**
 * The ROLE color mode (M10d). Two rules, and they are the same two every
 * semantic channel in this renderer obeys: a color means what the artifact
 * says it means, and an element the model says nothing about is NOT given a
 * hue that would claim otherwise.
 */
function box(id: string, role?: string): BuildingBox {
  return {
    id,
    name: id,
    kind: "class",
    isStub: false,
    district: "d",
    identity: undefined,
    center: [0, 0, 0],
    size: [1, 1, 1],
    metrics: {},
    attributes: [],
    operations: [],
    owner: undefined,
    source: undefined,
    ...(role === undefined ? {} : { role }),
  } as unknown as BuildingBox;
}

describe("roleColoring", () => {
  it("paints each role its own color and leaves an unclassified building null", () => {
    const { colors, roles } = roleColoring([
      box("a", "service"),
      box("b", "controller"),
      box("c"),
    ]);
    expect(roles).toEqual(["controller", "service"]);
    expect(colors[0]).not.toBe(colors[1]);
    // No role: no hue. The renderer paints it neutral.
    expect(colors[2]).toBeNull();
  });

  it("takes the artifact's declared domain, so the legend lists filtered-out roles too", () => {
    const { roles, swatches } = roleColoring([box("a", "service")], [
      "service",
      "repository",
      "configuration",
    ]);
    expect(roles).toEqual(["configuration", "repository", "service"]);
    expect(new Set(swatches).size).toBe(3);
  });

  it("is deterministic and stable per role, not per position", () => {
    const first = roleColoring([box("a", "service"), box("b", "repository")]);
    // The same role in a different corpus, at a different rank: same color.
    const second = roleColoring([box("x", "repository"), box("y", "service"), box("z", "controller")]);
    const serviceFirst = first.swatches[first.roles.indexOf("service")];
    const serviceSecond = second.swatches[second.roles.indexOf("service")];
    expect(serviceSecond).toBe(serviceFirst);
  });

  it("still colors a role the palette does not name, deterministically", () => {
    const a = roleColoring([box("a", "listener")], ["listener"]);
    const b = roleColoring([box("a", "listener")], ["listener"]);
    expect(a.swatches[0]).toBe(b.swatches[0]);
    expect(a.colors[0]).not.toBeNull();
  });
});
