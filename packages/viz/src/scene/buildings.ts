import type {
  BuildingAttribute,
  BuildingOperation,
  BuildingSource,
  CityLayout,
  IdentityComponents,
} from "@codegraph/city";
import { districtLevels, plateTop } from "./districts.js";

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
  /** Display components from the artifact; absent on pre-identity artifacts. */
  readonly identity: IdentityComponents | undefined;
  /** Center of the box, world space. */
  readonly center: readonly [number, number, number];
  /** Extent along world x (width), y (height), z (depth). */
  readonly size: readonly [number, number, number];
  /** Raw measurements, verbatim from the artifact; `null` = unmeasured. */
  readonly metrics: Readonly<Record<string, number | null>>;
  /** Verbatim from the artifact; empty (never absent) on older artifacts. */
  readonly attributes: readonly BuildingAttribute[];
  readonly operations: readonly BuildingOperation[];
  /** Dominant author of the element's file, when a history was joined. */
  readonly owner: { readonly name: string; readonly share: number } | undefined;
  /** Where it is written; absent when the model anchors it nowhere (stubs). */
  readonly source: BuildingSource | undefined;
  /** The architectural role a framework profile assigned it, if any (M10d). */
  readonly role: string | undefined;
}

/**
 * One box per building, in artifact order (sorted by id) — the instance index
 * of a picked mesh maps back to a building by position in this array.
 * Buildings stand ON their district's plate, whose height follows its
 * nesting level (a nested district's plate stacks on its parent's).
 */
export function buildingBoxes(city: CityLayout): readonly BuildingBox[] {
  const levels = districtLevels(city);
  return city.buildings.map((building) => {
    const base = plateTop(levels.get(building.district) ?? 0);
    return {
      id: building.id,
      name: building.name,
      kind: building.kind,
      isStub: building.isStub,
      district: building.district,
      center: [
        building.position.x + building.footprint.width / 2,
        base + building.height / 2,
        building.position.y + building.footprint.depth / 2,
      ],
      size: [building.footprint.width, building.height, building.footprint.depth],
      metrics: building.metrics,
      identity: building.identity,
      attributes: building.attributes ?? [],
      operations: building.operations ?? [],
      owner: building.owner,
      source: building.source,
      role: building.role,
    };
  });
}

/** Roof center — where arrows attach (`conventions.arrowAttachment: "roof"`). */
export function roofOf(box: BuildingBox): readonly [number, number, number] {
  return [box.center[0], box.center[1] + box.size[1] / 2, box.center[2]];
}
