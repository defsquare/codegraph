import { describe, expect, it } from "vitest";
import { districtLevels, districtPlates, groundPlate, plateTop } from "../src/scene/districts.js";
import { GROUND_MARGIN, GROUND_THICKNESS, PLATE_THICKNESS } from "../src/theme.js";
import { makeCity } from "./fixture.js";

describe("districtLevels", () => {
  it("derives nesting depth from parent links, roots at 0", () => {
    const levels = districtLevels(makeCity());
    expect(levels.get("java:com.acme.order")).toBe(0);
    expect(levels.get("java:com.acme.order.deep")).toBe(1);
    expect(levels.get("java:com.acme.web")).toBe(0);
  });

  it("demotes a cyclic parent chain to roots instead of recursing forever", () => {
    const city = makeCity();
    const twisted = {
      ...city,
      districts: city.districts.map((district) =>
        district.id === "java:com.acme.order"
          ? { ...district, parent: "java:com.acme.order.deep" }
          : district,
      ),
    };
    const levels = districtLevels(twisted as never);
    for (const level of levels.values()) {
      expect(level).toBeLessThanOrEqual(1);
    }
  });
});

describe("districtPlates", () => {
  const city = makeCity();
  const plates = districtPlates(city);

  it("turns each district's bounds into a plate resting on the ground", () => {
    expect(plates).toHaveLength(3);
    const order = plates[0]!;
    // bounds (0, 0, 18x14): centered, top face at PLATE_THICKNESS.
    expect(order.center).toEqual([9, PLATE_THICKNESS / 2, 7]);
    expect(order.size).toEqual([18, PLATE_THICKNESS, 14]);
  });

  it("stacks a nested plate one thickness above its parent", () => {
    const deep = plates.find((plate) => plate.id === "java:com.acme.order.deep")!;
    expect(deep.level).toBe(1);
    expect(deep.center[1]).toBeCloseTo(PLATE_THICKNESS * 1.5);
    expect(plateTop(deep.level)).toBeCloseTo(2 * PLATE_THICKNESS);
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
