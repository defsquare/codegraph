import type { CityLayout } from "@codegraph/city";

/**
 * A hand-laid three-building city, structurally identical to what
 * `codegraph city --layout` writes. Values are chosen so tests can assert
 * exact centers/roofs: district A at (0,0), district B at (20,0).
 */
export function makeCity(overrides: Partial<CityLayout> = {}): CityLayout {
  const city = {
    kind: "codegraph.city/1",
    generatedBy: "@codegraph/city",
    view: {
      name: "full",
      internalOnly: false,
      declaredOnly: false,
      description: "every entity and every edge",
    },
    conventions: {
      arrowAttachment: "roof",
      heightAxis: "y",
      groundPlane: "xz",
      units: "city",
    },
    bindings: [
      {
        channel: "height",
        metric: "loc",
        unit: "lines",
        describe: "lines of code spanned by the entity's anchor",
        scale: "linear",
        range: { min: 1, max: 40 },
        domain: { min: 4, max: 120 },
        unmeasured: 1,
      },
      {
        channel: "footprint",
        metric: "members",
        unit: "entities",
        describe: "entities folded into the building",
        scale: "sqrt",
        range: { min: 2, max: 14 },
        domain: { min: 1, max: 9 },
        unmeasured: 0,
      },
    ],
    districts: [
      {
        id: "java:com.acme.order",
        name: "com.acme.order",
        kind: "module",
        isStub: false,
        buildings: ["java:com.acme.order/OrderService", "java:com.acme.order/Order"],
        footprintDemand: 52,
        bounds: { x: 0, y: 0, width: 18, depth: 14 },
      },
      {
        id: "java:com.acme.web",
        name: "com.acme.web",
        kind: "module",
        isStub: false,
        buildings: ["java:com.acme.web/OrderController"],
        footprintDemand: 16,
        bounds: { x: 20, y: 0, width: 10, depth: 10 },
      },
    ],
    buildings: [
      {
        id: "java:com.acme.order/Order",
        name: "Order",
        kind: "class",
        isStub: false,
        district: "java:com.acme.order",
        height: 10,
        footprint: { width: 4, depth: 4 },
        position: { x: 10, y: 3 },
        metrics: { loc: 30, members: 4 },
      },
      {
        id: "java:com.acme.order/OrderService",
        name: "OrderService",
        kind: "class",
        isStub: false,
        district: "java:com.acme.order",
        height: 40,
        footprint: { width: 6, depth: 6 },
        position: { x: 3, y: 3 },
        metrics: { loc: 120, members: 9 },
      },
      {
        id: "java:com.acme.web/OrderController",
        name: "OrderController",
        kind: "class",
        isStub: true,
        district: "java:com.acme.web",
        height: 1,
        footprint: { width: 4, depth: 4 },
        position: { x: 23, y: 3 },
        metrics: { loc: null, members: 1 },
      },
    ],
    arrows: [
      {
        from: "java:com.acme.order/OrderService",
        to: "java:com.acme.order/Order",
        count: 6,
        kinds: ["accesses", "invokes"],
        provenances: ["declared"],
        inferred: false,
        crossDistrict: false,
      },
      {
        from: "java:com.acme.web/OrderController",
        to: "java:com.acme.order/OrderService",
        count: 2,
        kinds: ["invokes"],
        provenances: ["declared", "derived"],
        inferred: true,
        crossDistrict: true,
      },
    ],
    diagnostics: {
      unplacedBuildings: [],
      droppedArrows: 0,
      selfArrows: 0,
      unmeasured: { loc: 1 },
      fold: { unfoldableEntities: 0, droppedEdges: 0, foldedEdges: 8 },
    },
    layout: {
      algorithm: "shelf-rows",
      order: "area-desc,id-asc",
      buildingGap: 2,
      districtPadding: 3,
      districtGap: 6,
    },
    bounds: { x: 0, y: 0, width: 30, depth: 14 },
    ...overrides,
  };
  return city as unknown as CityLayout;
}
