import type { CityLayout } from "@codegraph/city";
import { PLATE_THICKNESS } from "../theme.js";

/**
 * The scene model: the city artifact turned into plain world-space geometry —
 * numbers a unit test asserts on and any renderer can upload. No Three.js, no
 * DOM anywhere under src/scene.
 *
 * Axis mapping, per the artifact's conventions (`groundPlane: "xz"`,
 * `heightAxis: "y"`): layout `x` -> world x, layout `y` -> world z, height -> y.
 */
export interface BuildingBox {
  readonly id: string;
  readonly name: string | undefined;
  readonly kind: string;
  readonly isStub: boolean;
  readonly district: string;
  /** Center of the box, world space. */
  readonly center: readonly [number, number, number];
  /** Extent along world x (width), y (height), z (depth). */
  readonly size: readonly [number, number, number];
  /** Raw measurements, verbatim from the artifact; `null` = unmeasured. */
  readonly metrics: Readonly<Record<string, number | null>>;
}

/**
 * One box per building, in artifact order (sorted by id) — the instance index
 * of a picked mesh maps back to a building by position in this array.
 * Buildings stand ON their district plate, so bases sit at PLATE_THICKNESS.
 */
export function buildingBoxes(city: CityLayout): readonly BuildingBox[] {
  return city.buildings.map((building) => ({
    id: building.id,
    name: building.name,
    kind: building.kind,
    isStub: building.isStub,
    district: building.district,
    center: [
      building.position.x + building.footprint.width / 2,
      PLATE_THICKNESS + building.height / 2,
      building.position.y + building.footprint.depth / 2,
    ],
    size: [building.footprint.width, building.height, building.footprint.depth],
    metrics: building.metrics,
  }));
}

/** Roof center — where arrows attach (`conventions.arrowAttachment: "roof"`). */
export function roofOf(box: BuildingBox): readonly [number, number, number] {
  return [box.center[0], box.center[1] + box.size[1] / 2, box.center[2]];
}
