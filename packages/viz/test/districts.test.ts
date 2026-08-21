import { describe, expect, it } from "vitest";
import { districtPlates, groundPlate } from "../src/scene/districts.js";
import { GROUND_MARGIN, GROUND_THICKNESS, PLATE_THICKNESS } from "../src/theme.js";
import { makeCity } from "./fixture.js";

describe("districtPlates", () => {
  const city = makeCity();

  it("turns each district's bounds into a plate resting on the ground", () => {
    const plates = districtPlates(city);
    expect(plates).toHaveLength(2);
    const order = plates[0]!;
    // bounds (0, 0, 18x14): centered, top face at PLATE_THICKNESS.
    expect(order.center).toEqual([9, PLATE_THICKNESS / 2, 7]);
    expect(order.size).toEqual([18, PLATE_THICKNESS, 14]);
  });

  it("lays the ground under the whole plane with its top face at y = 0", () => {
    const ground = groundPlate(city);
    expect(ground.center).toEqual([15, -GROUND_THICKNESS / 2, 7]);
    expect(ground.size).toEqual([
      30 + 2 * GROUND_MARGIN,
      GROUND_THICKNESS,
      14 + 2 * GROUND_MARGIN,
    ]);
  });
});
