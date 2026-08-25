import { describe, expect, it } from "vitest";
import type { BuildingBox } from "../src/scene/buildings.js";
import { hslToHex, ownerColoring } from "../src/scene/owners.js";

const box = (id: string, owner?: { name: string; share: number }): BuildingBox =>
  ({ id, owner }) as unknown as BuildingBox;

describe("ownerColoring", () => {
  it("gives every distinct owner one deterministic hue, unowned buildings null", () => {
    const boxes = [
      box("a", { name: "alice <a@x>", share: 1 }),
      box("b", { name: "bob <b@x>", share: 0.6 }),
      box("c"),
      box("d", { name: "alice <a@x>", share: 0.9 }),
    ];
    const coloring = ownerColoring(boxes);
    expect(coloring.owners).toEqual(["alice <a@x>", "bob <b@x>"]);
    expect(coloring.colors[0]).toBe(coloring.colors[3]); // same owner, same hue
    expect(coloring.colors[0]).not.toBe(coloring.colors[1]); // different owners differ
    expect(coloring.colors[2]).toBeNull(); // no owner, no hue — never a claim
    // Deterministic: a second run colors identically.
    expect(ownerColoring(boxes)).toEqual(coloring);
  });

  it("has no owners at all on a city without a joined history", () => {
    const coloring = ownerColoring([box("a"), box("b")]);
    expect(coloring.owners).toEqual([]);
    expect(coloring.colors).toEqual([null, null]);
  });
});

describe("hslToHex", () => {
  it("maps the primaries", () => {
    expect(hslToHex(0, 1, 0.5)).toBe(0xff0000);
    expect(hslToHex(1 / 3, 1, 0.5)).toBe(0x00ff00);
    expect(hslToHex(0, 0, 1)).toBe(0xffffff);
    expect(hslToHex(0, 0, 0)).toBe(0x000000);
  });
});
