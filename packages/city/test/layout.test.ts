import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildCity, type Building, type CityModel, type District } from "../src/city.js";
import {
  LAYOUT_ALGORITHM,
  layoutCity,
  type Bounds,
  type CityLayout,
  type PlacedBuilding,
  type PlacedDistrict,
} from "../src/layout.js";
import { javaGraph } from "./fixture.js";

/**
 * What these tests guard is the CONTRACT of placement, not one packer's
 * arithmetic: every building stands somewhere, nothing overlaps, streets and
 * avenues stay open, a district contains exactly its buildings, and the same
 * city lays out byte-identically twice. The packer behind those promises is
 * replaceable; these properties are not.
 */

const EPS = 1e-6;

/** Fabricate a minimal city: layout must read only districts and footprints. */
function cityOf(
  specs: readonly { id: string; district: string; width: number; depth: number; height?: number }[],
): CityModel {
  const buildings: Building[] = [...specs]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((spec) => ({
      id: spec.id,
      name: spec.id,
      kind: "class",
      isStub: false,
      district: spec.district,
      height: spec.height ?? 10,
      footprint: { width: spec.width, depth: spec.depth },
      metrics: {},
      attributes: [],
      operations: [],
    }));
  const grouped = new Map<string, Building[]>();
  for (const building of buildings) {
    grouped.set(building.district, [...(grouped.get(building.district) ?? []), building]);
  }
  const districts: District[] = [...grouped.keys()].sort().map((id) => ({
    id,
    name: id,
    kind: "package",
    isStub: false,
    buildings: (grouped.get(id) ?? []).map((building) => building.id),
    footprintDemand: (grouped.get(id) ?? []).reduce(
      (total, building) => total + building.footprint.width * building.footprint.depth,
      0,
    ),
  }));
  return {
    kind: "codegraph.city/1",
    generatedBy: "@codegraph/city",
    view: { name: "all", filters: [] },
    corpus: { name: "toy", roots: [] },
    conventions: { arrowAttachment: "roof", heightAxis: "y", groundPlane: "xz", units: "city" },
    bindings: [],
    districts,
    buildings,
    arrows: [],
    districtArrows: [],
    diagnostics: {
      unplacedBuildings: [],
      droppedArrows: 0,
      selfArrows: 0,
      droppedDistrictArrows: 0,
      selfDistrictArrows: 0,
      unmeasured: {},
      fold: { unfoldableEntities: 0, droppedEdges: 0, foldedEdges: 0 },
    },
  };
}

function footprintOf(building: PlacedBuilding): Bounds {
  return {
    x: building.position.x,
    y: building.position.y,
    width: building.footprint.width,
    depth: building.footprint.depth,
  };
}

/** Disjoint with at least `gap` of open ground along one axis. */
function separated(a: Bounds, b: Bounds, gap: number): boolean {
  return (
    a.x + a.width + gap <= b.x + EPS ||
    b.x + b.width + gap <= a.x + EPS ||
    a.y + a.depth + gap <= b.y + EPS ||
    b.y + b.depth + gap <= a.y + EPS
  );
}

function contains(outer: Bounds, inner: Bounds, inset: number): boolean {
  return (
    inner.x >= outer.x + inset - EPS &&
    inner.y >= outer.y + inset - EPS &&
    inner.x + inner.width <= outer.x + outer.width - inset + EPS &&
    inner.y + inner.depth <= outer.y + outer.depth - inset + EPS
  );
}

/** Every promise the layout makes, checked on one laid-out city. */
function assertWellFormed(laid: CityLayout): void {
  const districtById = new Map(laid.districts.map((district) => [district.id, district]));
  const { buildingGap, districtPadding, districtGap } = laid.layout;

  for (const building of laid.buildings) {
    const district = districtById.get(building.district);
    expect(district, `building ${building.id} has a district`).toBeDefined();
    if (district === undefined) continue;
    expect(
      contains(district.bounds, footprintOf(building), districtPadding),
      `${building.id} stands inside ${district.id}, clear of the border`,
    ).toBe(true);
  }

  for (const district of laid.districts) {
    const placed = laid.buildings.filter((building) => building.district === district.id);
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        const a = placed[i] as PlacedBuilding;
        const b = placed[j] as PlacedBuilding;
        expect(
          separated(footprintOf(a), footprintOf(b), buildingGap),
          `${a.id} and ${b.id} keep a street of ${buildingGap} open`,
        ).toBe(true);
      }
    }
  }

  // Nesting rewrote the old "every pair keeps an avenue" promise. The durable
  // properties: an ancestor CONTAINS its descendants, clear of its sidewalk;
  // two unrelated districts stay apart — by an avenue when both are roots, by
  // at least a street when either is nested inside some parent.
  const isAncestor = (a: PlacedDistrict, b: PlacedDistrict): boolean => {
    for (let parent = b.parent; parent !== undefined; ) {
      if (parent === a.id) return true;
      parent = districtById.get(parent)?.parent;
    }
    return false;
  };
  for (let i = 0; i < laid.districts.length; i += 1) {
    for (let j = i + 1; j < laid.districts.length; j += 1) {
      const a = laid.districts[i] as PlacedDistrict;
      const b = laid.districts[j] as PlacedDistrict;
      if (isAncestor(a, b) || isAncestor(b, a)) {
        const [outer, inner] = isAncestor(a, b) ? [a, b] : [b, a];
        expect(
          contains(outer.bounds, inner.bounds, districtPadding),
          `${inner.id} lies inside ${outer.id}, clear of the sidewalk`,
        ).toBe(true);
      } else {
        const gap = a.parent === undefined && b.parent === undefined ? districtGap : buildingGap;
        expect(
          separated(a.bounds, b.bounds, gap),
          `${a.id} and ${b.id} keep open ground of ${gap}`,
        ).toBe(true);
      }
    }
  }

  // A district's own buildings and its child districts share one packing, so
  // they too keep a street open.
  for (const district of laid.districts) {
    if (district.parent === undefined) continue;
    const parent = districtById.get(district.parent);
    if (parent === undefined) continue;
    for (const building of laid.buildings.filter((b) => b.district === parent.id)) {
      expect(
        separated(district.bounds, footprintOf(building), buildingGap),
        `${building.id} keeps a street from nested ${district.id}`,
      ).toBe(true);
    }
  }

  for (const district of laid.districts) {
    expect(
      contains(laid.bounds, district.bounds, 0),
      `${district.id} lies within the city bounds`,
    ).toBe(true);
  }
}

describe("layoutCity places everything", () => {
  const city = cityOf([
    { id: "java:a/Big", district: "java:a", width: 12, depth: 12 },
    { id: "java:a/Mid", district: "java:a", width: 6, depth: 6 },
    { id: "java:a/Tiny", district: "java:a", width: 2, depth: 2 },
    { id: "java:b/Other", district: "java:b", width: 8, depth: 8 },
  ]);

  it("gives every building a position and every district bounds", () => {
    const laid = layoutCity(city);
    expect(laid.buildings).toHaveLength(city.buildings.length);
    expect(laid.districts).toHaveLength(city.districts.length);
    for (const building of laid.buildings) {
      expect(building.position.x).toBeTypeOf("number");
      expect(building.position.y).toBeTypeOf("number");
    }
    for (const district of laid.districts) {
      expect(district.bounds.width).toBeGreaterThan(0);
      expect(district.bounds.depth).toBeGreaterThan(0);
    }
    assertWellFormed(laid);
  });

  it("changes nothing the city model already said", () => {
    const laid = layoutCity(city);
    // Same order, same ids, and every pre-existing key byte-identical.
    laid.buildings.forEach((building, index) => {
      const { position: _position, ...rest } = building;
      expect(rest).toStrictEqual(city.buildings[index]);
    });
    laid.districts.forEach((district, index) => {
      const { bounds: _bounds, ...rest } = district;
      expect(rest).toStrictEqual(city.districts[index]);
    });
    expect(laid.arrows).toBe(city.arrows);
    expect(laid.kind).toBe(city.kind);
  });

  it("declares its algorithm and parameters in the artefact", () => {
    const laid = layoutCity(city);
    expect(laid.layout.algorithm).toBe(LAYOUT_ALGORITHM);
    expect(laid.layout.order).toBe("area-desc,id-asc");
    expect(laid.layout.buildingGap).toBeGreaterThan(0);
    expect(laid.layout.districtPadding).toBeGreaterThan(0);
    expect(laid.layout.districtGap).toBeGreaterThan(0);
  });

  it("honours caller-supplied streets, sidewalks and avenues", () => {
    const laid = layoutCity(city, { buildingGap: 5, districtPadding: 4, districtGap: 11 });
    expect(laid.layout).toMatchObject({ buildingGap: 5, districtPadding: 4, districtGap: 11 });
    assertWellFormed(laid);
  });

  it("rejects a negative gap instead of folding buildings into each other", () => {
    expect(() => layoutCity(city, { buildingGap: -1 })).toThrow(/buildingGap/);
  });
});

describe("degenerate cities", () => {
  it("an empty city lays out to an empty ground plane", () => {
    const laid = layoutCity(cityOf([]));
    expect(laid.districts).toHaveLength(0);
    expect(laid.buildings).toHaveLength(0);
    expect(laid.bounds).toStrictEqual({ x: 0, y: 0, width: 0, depth: 0 });
    expect(laid.layout.algorithm).toBe(LAYOUT_ALGORITHM);
  });

  it("a lone building stands at the sidewalk corner of its district", () => {
    const laid = layoutCity(cityOf([{ id: "java:a/Only", district: "java:a", width: 4, depth: 4 }]));
    const district = laid.districts[0] as (typeof laid.districts)[number];
    const building = laid.buildings[0] as PlacedBuilding;
    const padding = laid.layout.districtPadding;
    expect(building.position).toStrictEqual({
      x: district.bounds.x + padding,
      y: district.bounds.y + padding,
    });
    expect(district.bounds.width).toBeCloseTo(4 + 2 * padding, 6);
    expect(district.bounds.depth).toBeCloseTo(4 + 2 * padding, 6);
  });
});

describe("readability over density", () => {
  it("a district of equal buildings settles into a square-ish block, not a strip", () => {
    const specs = Array.from({ length: 30 }, (_, index) => ({
      id: `java:a/T${String(index).padStart(2, "0")}`,
      district: "java:a",
      width: 5,
      depth: 5,
    }));
    const laid = layoutCity(cityOf(specs));
    const district = laid.districts[0] as (typeof laid.districts)[number];
    const aspect = district.bounds.width / district.bounds.depth;
    expect(aspect).toBeGreaterThan(1 / 3);
    expect(aspect).toBeLessThan(3);
  });

  it("many districts settle into a square-ish city", () => {
    const specs = Array.from({ length: 24 }, (_, index) => ({
      id: `java:p${String(index).padStart(2, "0")}/T`,
      district: `java:p${String(index).padStart(2, "0")}`,
      width: 6,
      depth: 6,
    }));
    const laid = layoutCity(cityOf(specs));
    const aspect = laid.bounds.width / laid.bounds.depth;
    expect(aspect).toBeGreaterThan(1 / 3);
    expect(aspect).toBeLessThan(3);
  });
});

describe("determinism", () => {
  it("the same city lays out byte-identically twice", () => {
    const specs = Array.from({ length: 17 }, (_, index) => ({
      id: `java:a/T${index}`,
      district: `java:${index % 3}`,
      width: 2 + (index % 7),
      depth: 2 + ((index * 3) % 5),
    }));
    const first = layoutCity(cityOf(specs));
    const second = layoutCity(cityOf(specs));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe("the real fixture", () => {
  it("lays out the Spoon-extracted city with every invariant intact", () => {
    const laid = layoutCity(buildCity(javaGraph()));
    expect(laid.buildings.length).toBeGreaterThan(0);
    assertWellFormed(laid);
    for (const building of laid.buildings) {
      expect(building.position.x).toBeGreaterThanOrEqual(0);
      expect(building.position.y).toBeGreaterThanOrEqual(0);
    }
  });

  it("nests the extractor's package containment as districts within districts", () => {
    const laid = layoutCity(buildCity(javaGraph()));
    const byId = new Map(laid.districts.map((district) => [district.id, district]));
    const adapter = byId.get("java:com.acme.order.adapter");
    const order = byId.get("java:com.acme.order");
    expect(adapter?.parent).toBe("java:com.acme.order");
    expect(byId.get("java:com.acme.order.legacy")?.parent).toBe("java:com.acme.order");
    // The child plot lies physically inside the parent's bounds.
    expect(adapter && order).toBeTruthy();
    if (adapter && order) {
      expect(adapter.bounds.x).toBeGreaterThanOrEqual(order.bounds.x);
      expect(adapter.bounds.y).toBeGreaterThanOrEqual(order.bounds.y);
      expect(adapter.bounds.x + adapter.bounds.width).toBeLessThanOrEqual(
        order.bounds.x + order.bounds.width + 1e-9,
      );
      expect(adapter.bounds.y + adapter.bounds.depth).toBeLessThanOrEqual(
        order.bounds.y + order.bounds.depth + 1e-9,
      );
    }
  });

  it("a cyclic or dangling parent demotes the district to a root, never crashes", () => {
    const city = buildCity(javaGraph());
    const twisted = {
      ...city,
      districts: city.districts.map((district) =>
        district.id === "java:com.acme.order"
          ? { ...district, parent: "java:com.acme.order.adapter" } // cycle with its own child
          : district.id === "java:com.megacorp.ledger"
            ? { ...district, parent: "java:not.a.district" } // dangling
            : district,
      ),
    };
    const laid = layoutCity(twisted);
    for (const district of laid.districts) {
      expect(district.bounds.width).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("properties", () => {
  const buildingArb = fc.record({
    district: fc.integer({ min: 0, max: 4 }),
    width: fc.double({ min: 0.5, max: 40, noNaN: true }),
    depth: fc.double({ min: 0.5, max: 40, noNaN: true }),
  });

  it("any city lays out with no overlap, full containment and open streets", () => {
    fc.assert(
      fc.property(fc.array(buildingArb, { minLength: 0, maxLength: 50 }), (specs) => {
        const city = cityOf(
          specs.map((spec, index) => ({
            id: `java:d${spec.district}/T${String(index).padStart(3, "0")}`,
            district: `java:d${spec.district}`,
            width: Math.round(spec.width * 1000) / 1000,
            depth: Math.round(spec.depth * 1000) / 1000,
          })),
        );
        assertWellFormed(layoutCity(city));
      }),
      { numRuns: 60 },
    );
  });
});
