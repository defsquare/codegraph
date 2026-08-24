import { describe, expect, it } from "vitest";
import { landscapeCenter } from "../src/scene/center.js";
import { makeCity } from "./fixture.js";

describe("landscapeCenter", () => {
  it("is the area-weighted centroid of building footprints, not the bounds center", () => {
    // Fixture buildings: Util 2x2 @ (2,9), Order 4x4 @ (10,3),
    // OrderService 6x6 @ (3,3), OrderController 4x4 @ (23,3).
    // Centroid = sum(area * footprint center) / sum(area).
    const center = landscapeCenter(makeCity());
    expect(center.x).toBeCloseTo(820 / 72);
    expect(center.z).toBeCloseTo(416 / 72);
    // The bounds rectangle center (15, 7) would sit right of the built mass.
    expect(center.x).not.toBeCloseTo(15);
  });

  it("counts stub buildings — they are part of the rendered landscape", () => {
    const city = makeCity();
    const withoutStub = {
      ...city,
      buildings: city.buildings.filter((building) => !building.isStub),
    };
    // Dropping the stub at (23..27) must pull the centroid left.
    expect(landscapeCenter(withoutStub as never).x).toBeLessThan(landscapeCenter(city).x);
  });

  it("falls back to the bounds center when there is nothing built", () => {
    const empty = { ...makeCity(), buildings: [] };
    const center = landscapeCenter(empty as never);
    expect(center).toEqual({ x: 15, z: 7 });
  });

  it("falls back to the bounds center when every footprint has zero area", () => {
    const city = makeCity();
    const flat = {
      ...city,
      buildings: city.buildings.map((building) => ({
        ...building,
        footprint: { width: 0, depth: 0 },
      })),
    };
    const center = landscapeCenter(flat as never);
    expect(center).toEqual({ x: 15, z: 7 });
  });
});
