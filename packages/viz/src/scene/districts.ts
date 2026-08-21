import type { CityLayout } from "@codegraph/city";
import { GROUND_MARGIN, GROUND_THICKNESS, PLATE_THICKNESS } from "../theme.js";

/** An axis-aligned slab on the ground: a district plate or the ground itself. */
export interface Plate {
  readonly id: string;
  readonly name: string | undefined;
  readonly isStub: boolean;
  readonly center: readonly [number, number, number];
  readonly size: readonly [number, number, number];
}

/**
 * One plate per district, from its layout bounds, resting on the ground plane
 * (top face at PLATE_THICKNESS — the level buildings stand on).
 */
export function districtPlates(city: CityLayout): readonly Plate[] {
  return city.districts.map((district) => ({
    id: district.id,
    name: district.name,
    isStub: district.isStub,
    center: [
      district.bounds.x + district.bounds.width / 2,
      PLATE_THICKNESS / 2,
      district.bounds.y + district.bounds.depth / 2,
    ],
    size: [district.bounds.width, PLATE_THICKNESS, district.bounds.depth],
  }));
}

/** The ground slab: the layout's whole plane plus a margin, top face at y = 0. */
export function groundPlate(city: CityLayout): Plate {
  const bounds = city.bounds;
  return {
    id: "ground",
    name: undefined,
    isStub: false,
    center: [
      bounds.x + bounds.width / 2,
      -GROUND_THICKNESS / 2,
      bounds.y + bounds.depth / 2,
    ],
    size: [bounds.width + 2 * GROUND_MARGIN, GROUND_THICKNESS, bounds.depth + 2 * GROUND_MARGIN],
  };
}
