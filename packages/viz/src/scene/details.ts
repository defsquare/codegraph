import type { DistrictArc } from "./districtArrows.js";
import type { BuildingBox } from "./buildings.js";
import type { Plate } from "./districts.js";
import { districtLabel } from "./labels.js";

/**
 * The click panel's data, DOM-free: what the shell prints when a building or
 * district is selected. The arithmetic the hover tooltip used to inline
 * (children counts, fan sums) lives here, tested, and the DOM layer only
 * renders rows. `unmeasured` keeps its own class so a missing measurement can
 * never be styled as a value (CLAUDE.md: honesty).
 */
export interface DetailRow {
  readonly label: string;
  readonly value: string;
  readonly className?: string;
}

export interface DistrictDetails {
  readonly title: string;
  readonly meta: string;
  readonly rows: readonly DetailRow[];
}

export interface BuildingDetails {
  readonly title: string;
  readonly meta: string;
  readonly rows: readonly DetailRow[];
  readonly attributes: BuildingBox["attributes"];
  readonly operations: BuildingBox["operations"];
}

export function districtDetails(
  plates: readonly Plate[],
  boxes: readonly BuildingBox[],
  arcs: readonly DistrictArc[],
  plate: Plate,
): DistrictDetails {
  const buildings = boxes.filter((box) => box.district === plate.id).length;
  const nested = plates.filter((candidate) => candidate.parent === plate.id).length;
  const fanIn = arcs.filter((arc) => arc.to === plate.id);
  const fanOut = arcs.filter((arc) => arc.from === plate.id);
  const sum = (fan: readonly DistrictArc[]): number =>
    fan.reduce((total, arc) => total + arc.count, 0);
  return {
    title: districtLabel(plate),
    meta:
      `module${plate.isStub ? " (stub)" : ""}` +
      `${plate.parent === undefined ? "" : ` — in ${plate.parent}`}`,
    rows: [
      { label: "buildings", value: String(buildings) },
      { label: "nested districts", value: String(nested) },
      { label: "fan-in", value: `${fanIn.length} modules / ${sum(fanIn)} deps` },
      { label: "fan-out", value: `${fanOut.length} modules / ${sum(fanOut)} deps` },
    ],
  };
}

export function buildingDetails(box: BuildingBox): BuildingDetails {
  return {
    title: box.name ?? box.id,
    // The module component when the artifact gives it; the district id is the
    // opaque fallback for artifacts from before `identity` existed.
    meta:
      `${box.kind}${box.isStub ? " (stub)" : ""} — ` +
      `${box.identity?.module ?? box.district}`,
    rows: Object.entries(box.metrics).map(([metric, value]) =>
      value === null
        ? { label: metric, value: "unmeasured", className: "unmeasured" }
        : { label: metric, value: String(value) },
    ),
    attributes: box.attributes,
    operations: box.operations,
  };
}
