import type { CityLayout } from "@codegraph/city";
import { ARC_LIFT_RATIO, ARC_MIN_LIFT, ARC_SEGMENTS } from "../theme.js";
import { roofOf, type BuildingBox } from "./buildings.js";

/**
 * One dependency arrow as a sampled roof-to-roof arc.
 *
 * `inferred` is copied from the artifact, NEVER recomputed from provenances —
 * the city model precomputed it precisely so a renderer cannot get the rule
 * wrong (CM-3). Same for `crossDistrict`.
 */
export interface ArrowArc {
  readonly from: string;
  readonly to: string;
  readonly count: number;
  readonly inferred: boolean;
  readonly crossDistrict: boolean;
  /** In the minimum feedback set — the analyzer's cycle cut. Copied verbatim;
   * an artifact from before the field reads as false. */
  readonly feedback: boolean;
  /** True when either endpoint is a stub — a dependency on code the corpus
   * does not declare; the externals toggle gates these. */
  readonly external: boolean;
  /** Aggregated edge count mapped to [0, 1] on a log scale over this city. */
  readonly weight: number;
  /** ARC_SEGMENTS + 1 world-space samples of a quadratic Bezier, from -> to. */
  readonly points: readonly (readonly [number, number, number])[];
}

/**
 * Arc every arrow whose two endpoints are buildings of this city. The city
 * model already dropped arrows with unplaced endpoints (and counted them in
 * diagnostics); an id still missing here would be a malformed artifact, and
 * skipping it beats drawing an arrow from nowhere.
 */
export function arrowArcs(city: CityLayout, boxes: readonly BuildingBox[]): readonly ArrowArc[] {
  const byId = new Map(boxes.map((box) => [box.id, box] as const));
  const maxCount = city.arrows.reduce((max, arrow) => Math.max(max, arrow.count), 0);

  return city.arrows.flatMap((arrow) => {
    const from = byId.get(arrow.from);
    const to = byId.get(arrow.to);
    if (from === undefined || to === undefined) return [];
    return [
      {
        from: arrow.from,
        to: arrow.to,
        count: arrow.count,
        inferred: arrow.inferred,
        crossDistrict: arrow.crossDistrict,
        feedback: arrow.feedback === true,
        external: from.isStub || to.isStub,
        weight: maxCount <= 1 ? 1 : Math.log1p(arrow.count) / Math.log1p(maxCount),
        points: sampleArc(roofOf(from), roofOf(to)),
      },
    ];
  });
}

/**
 * Quadratic Bezier whose APEX (t = 0.5) clears the taller endpoint by a lift
 * that grows with distance: short arrows hop, long arrows fly over the
 * skyline. The control height is solved from the apex — apex = (p0 + 2c + p2)/4
 * — so the guarantee holds for unequal endpoint heights too. `clearance`
 * raises the minimum lift; district arcs pass the skyline height so they never
 * cut through a building standing between two plates.
 */
export function sampleArc(
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  clearance = 0,
): readonly (readonly [number, number, number])[] {
  const [x0, y0, z0] = from;
  const [x1, y1, z1] = to;
  const horizontal = Math.hypot(x1 - x0, z1 - z0);
  const apex =
    Math.max(y0, y1) + Math.max(ARC_MIN_LIFT, ARC_LIFT_RATIO * horizontal, clearance);
  const cx = (x0 + x1) / 2;
  const cy = (4 * apex - y0 - y1) / 2;
  const cz = (z0 + z1) / 2;

  const points: (readonly [number, number, number])[] = [];
  for (let i = 0; i <= ARC_SEGMENTS; i += 1) {
    const t = i / ARC_SEGMENTS;
    const a = (1 - t) * (1 - t);
    const b = 2 * (1 - t) * t;
    const c = t * t;
    points.push([
      a * x0 + b * cx + c * x1,
      a * y0 + b * cy + c * y1,
      a * z0 + b * cz + c * z1,
    ]);
  }
  return points;
}
