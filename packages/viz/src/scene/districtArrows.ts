import type { CityLayout } from "@codegraph/city";
import { ARC_SEGMENTS } from "../theme.js";
import { sampleArc } from "./arrows.js";
import type { BuildingBox } from "./buildings.js";
import type { Plate } from "./districts.js";

/**
 * One module-level dependency as a plate-top-to-plate-top arc. These are the
 * artifact's `districtArrows` — the analyzer's module fold — never an
 * aggregation the renderer made up. As with type arrows, `inferred` is copied
 * verbatim.
 */
export interface DistrictArc {
  readonly from: string;
  readonly to: string;
  readonly count: number;
  readonly inferred: boolean;
  /** Aggregated edge count mapped to [0, 1] on a log scale over this city. */
  readonly weight: number;
  /** ARC_SEGMENTS + 1 world-space samples, from -> to. */
  readonly points: readonly (readonly [number, number, number])[];
}

/**
 * Arc every district arrow whose endpoints are plates of this city. All arcs
 * clear the skyline (the tallest building plus headroom), so a dependency
 * between two far plates never slices through the towers standing between.
 */
export function districtArcs(
  city: CityLayout,
  plates: readonly Plate[],
  boxes: readonly BuildingBox[],
): readonly DistrictArc[] {
  const arrows = city.districtArrows ?? [];
  const byId = new Map(plates.map((plate) => [plate.id, plate] as const));
  const maxCount = arrows.reduce((max, arrow) => Math.max(max, arrow.count), 0);
  const skyline = boxes.reduce(
    (top, box) => Math.max(top, box.center[1] + box.size[1] / 2),
    0,
  );

  return arrows.flatMap((arrow) => {
    const from = byId.get(arrow.from);
    const to = byId.get(arrow.to);
    if (from === undefined || to === undefined) return [];
    return [
      {
        from: arrow.from,
        to: arrow.to,
        count: arrow.count,
        inferred: arrow.inferred,
        weight: maxCount <= 1 ? 1 : Math.log1p(arrow.count) / Math.log1p(maxCount),
        points: sampleArc(topCenter(from), topCenter(to), skyline * 1.15 + 2),
      },
    ];
  });
}

/** Where a district arc attaches: the center of the plate's top face. */
export function topCenter(plate: Plate): readonly [number, number, number] {
  return [plate.center[0], plate.center[1] + plate.size[1] / 2, plate.center[2]];
}

export { ARC_SEGMENTS };
