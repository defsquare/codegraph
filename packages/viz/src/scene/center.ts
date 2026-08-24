import type { CityLayout } from "@codegraph/city";

/**
 * The ground point the camera should orbit: the area-weighted centroid of the
 * building footprints. The bounds rectangle's center is NOT that point — the
 * shelf packer places the dense corpus districts first and fills the remaining
 * shelves with near-empty stub plates, so the rectangle's center drifts into
 * open ground beside the built mass. Stub buildings count: they are rendered
 * landscape. A city with nothing built (or only zero-area footprints) falls
 * back to the bounds center — the only center it has.
 */
export function landscapeCenter(city: CityLayout): { x: number; z: number } {
  let area = 0;
  let x = 0;
  let z = 0;
  for (const building of city.buildings) {
    const { width, depth } = building.footprint;
    const weight = width * depth;
    area += weight;
    x += weight * (building.position.x + width / 2);
    z += weight * (building.position.y + depth / 2);
  }
  if (area <= 0) {
    return {
      x: city.bounds.x + city.bounds.width / 2,
      z: city.bounds.y + city.bounds.depth / 2,
    };
  }
  return { x: x / area, z: z / area };
}
