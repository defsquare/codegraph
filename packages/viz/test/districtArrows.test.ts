import { describe, expect, it } from "vitest";
import { buildingBoxes } from "../src/scene/buildings.js";
import { districtArcs, topCenter } from "../src/scene/districtArrows.js";
import { districtPlates } from "../src/scene/districts.js";
import { ARC_SEGMENTS } from "../src/theme.js";
import { makeCity } from "./fixture.js";

describe("districtArcs", () => {
  const city = makeCity();
  const plates = districtPlates(city);
  const boxes = buildingBoxes(city);
  const arcs = districtArcs(city, plates, boxes);
  const plateById = new Map(plates.map((plate) => [plate.id, plate] as const));

  it("arcs every district arrow from plate top to plate top", () => {
    expect(arcs).toHaveLength(city.districtArrows.length);
    for (const arc of arcs) {
      expect(arc.points).toHaveLength(ARC_SEGMENTS + 1);
      expect(arc.points[0]).toEqual(topCenter(plateById.get(arc.from)!));
      expect(arc.points[ARC_SEGMENTS]).toEqual(topCenter(plateById.get(arc.to)!));
    }
  });

  it("clears the skyline: the apex flies over the tallest building", () => {
    const skyline = boxes.reduce((top, box) => Math.max(top, box.center[1] + box.size[1] / 2), 0);
    for (const arc of arcs) {
      const apex = Math.max(...arc.points.map((point) => point[1]));
      expect(apex).toBeGreaterThan(skyline);
    }
  });

  it("copies inferred verbatim and weights by count", () => {
    expect(arcs.map((arc) => arc.inferred)).toEqual([false, true]);
    const weights = new Map(arcs.map((arc) => [arc.count, arc.weight] as const));
    expect(weights.get(3)).toBe(1);
    expect(weights.get(2)).toBeCloseTo(Math.log1p(2) / Math.log1p(3));
  });

  it("copies feedback verbatim, defaulting to false for artifacts predating it", () => {
    expect(arcs.map((arc) => arc.feedback)).toEqual([false, false]);
    const cut = makeCity({
      districtArrows: city.districtArrows.map((arrow, i) => ({
        ...arrow,
        feedback: i === 1,
      })) as never,
    });
    const cutArcs = districtArcs(cut, districtPlates(cut), buildingBoxes(cut));
    expect(cutArcs.map((arc) => arc.feedback)).toEqual([false, true]);
  });

  it("flags an arc external when either endpoint is a stub district", () => {
    // The fixture's districts are all corpus-declared: nothing is external.
    expect(arcs.map((arc) => arc.external)).toEqual([false, false]);
    // Re-plate with com.acme.web degraded to a stub module: its arc turns external.
    const stubbed = makeCity({
      districts: city.districts.map((district) =>
        district.id === "java:com.acme.web" ? { ...district, isStub: true } : district,
      ),
    } as never);
    const stubbedPlates = districtPlates(stubbed);
    const stubbedArcs = districtArcs(stubbed, stubbedPlates, buildingBoxes(stubbed));
    expect(stubbedArcs.map((arc) => [arc.from, arc.external])).toEqual([
      ["java:com.acme.order", false],
      ["java:com.acme.web", true],
    ]);
  });

  it("tolerates an artifact without districtArrows (older cities draw none)", () => {
    const bare = { ...city, districtArrows: undefined };
    expect(districtArcs(bare as never, plates, boxes)).toEqual([]);
  });
});
