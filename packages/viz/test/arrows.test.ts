import { describe, expect, it } from "vitest";
import { arrowArcs } from "../src/scene/arrows.js";
import { buildingBoxes, roofOf } from "../src/scene/buildings.js";
import { ARC_SEGMENTS } from "../src/theme.js";
import { makeCity } from "./fixture.js";

describe("arrowArcs", () => {
  const city = makeCity();
  const boxes = buildingBoxes(city);
  const arcs = arrowArcs(city, boxes);
  const byId = new Map(boxes.map((box) => [box.id, box] as const));

  it("produces one arc per arrow, endpoints exactly at the two roofs", () => {
    expect(arcs).toHaveLength(city.arrows.length);
    for (const arc of arcs) {
      expect(arc.points).toHaveLength(ARC_SEGMENTS + 1);
      expect(arc.points[0]).toEqual(roofOf(byId.get(arc.from)!));
      expect(arc.points[ARC_SEGMENTS]).toEqual(roofOf(byId.get(arc.to)!));
    }
  });

  it("keeps every arc sample at or above the lower roof, apex above the taller one", () => {
    for (const arc of arcs) {
      const roofs = [roofOf(byId.get(arc.from)!)[1], roofOf(byId.get(arc.to)!)[1]];
      const apex = Math.max(...arc.points.map((p) => p[1]));
      expect(apex).toBeGreaterThan(Math.max(...roofs));
      for (const point of arc.points) {
        expect(point[1]).toBeGreaterThanOrEqual(Math.min(...roofs) - 1e-9);
      }
    }
  });

  it("copies inferred and crossDistrict from the artifact, never recomputing", () => {
    // The fixture's second arrow says inferred although one provenance is
    // `declared` — the artifact's word is final.
    expect(arcs.map((arc) => arc.inferred)).toEqual([false, true]);
    expect(arcs.map((arc) => arc.crossDistrict)).toEqual([false, true]);
  });

  it("flags an arc external when either endpoint is a stub building", () => {
    // OrderController is the fixture's stub; the OrderService -> Order arc
    // stays internal.
    expect(arcs.map((arc) => arc.external)).toEqual([false, true]);
  });

  it("weights arrows by count, log-scaled to [0, 1] with the max at 1", () => {
    const weights = new Map(arcs.map((arc) => [arc.count, arc.weight] as const));
    expect(weights.get(6)).toBe(1);
    expect(weights.get(2)).toBeCloseTo(Math.log1p(2) / Math.log1p(6));
  });

  it("skips an arrow whose endpoint is not a building rather than inventing one", () => {
    const broken = makeCity({
      arrows: [
        ...city.arrows,
        {
          from: "java:ghost/Missing",
          to: "java:com.acme.order/Order",
          count: 1,
          kinds: ["invokes"],
          provenances: ["declared"],
          inferred: false,
          crossDistrict: true,
        },
      ] as never,
    });
    expect(arrowArcs(broken, buildingBoxes(broken))).toHaveLength(city.arrows.length);
  });

  it("gives every arrow weight 1 when all counts are equal", () => {
    const uniform = makeCity({
      arrows: city.arrows.map((arrow) => ({ ...arrow, count: 1 })) as never,
    });
    for (const arc of arrowArcs(uniform, buildingBoxes(uniform))) {
      expect(arc.weight).toBe(1);
    }
  });
});
