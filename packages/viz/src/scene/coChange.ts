import type { CityLayout, ReplayCityLayout } from "@codegraph/city";
import { sampleArc } from "./arrows.js";
import { roofOf, type BuildingBox } from "./buildings.js";

/**
 * CO-CHANGE ARCS (M9c): logical coupling mined from history, joined into the
 * replay artifact by the CLI. They are INFERENCES, not dependencies — the
 * renderer draws them dashed, in a hue no dependency arrow uses, and only for
 * the selected building: the picture never presents an inference as a fact.
 * Undirected: one arc serves both ends.
 */
export interface CoChangeArcModel {
  readonly a: string;
  readonly b: string;
  readonly support: number;
  readonly confidence: number;
  /** ARC_SEGMENTS + 1 world-space samples, a -> b (direction meaningless). */
  readonly points: readonly (readonly [number, number, number])[];
}

export function coChangeArcModels(
  city: CityLayout,
  boxes: readonly BuildingBox[],
): readonly CoChangeArcModel[] {
  const pairs = (city as Partial<ReplayCityLayout>).replay?.coChange ?? [];
  const byId = new Map(boxes.map((box) => [box.id, box] as const));
  return pairs.flatMap((pair) => {
    const a = byId.get(pair.a);
    const b = byId.get(pair.b);
    // A pair whose end never lived in this city is a malformed artifact;
    // skipping beats an arc from nowhere (the arrows rule).
    if (a === undefined || b === undefined) return [];
    return [
      {
        a: pair.a,
        b: pair.b,
        support: pair.support,
        confidence: pair.confidence,
        points: sampleArc(roofOf(a), roofOf(b)),
      },
    ];
  });
}
